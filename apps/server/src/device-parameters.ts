import type { DeviceParameter, ParameterList, ParameterType } from "@modelviz/protocol";
import { ProtocolFailure } from "./errors.ts";
import type { DecodedMessage, NodeAddress, OutgoingMessage, ParameterProtocol, ParameterReport } from "./frame-format.ts";

/** How long to wait for the Device's answer before asking again (ms). */
const ATTEMPT_MS = 500;
const ATTEMPTS = 3;

const INTEGER_RANGE: Partial<Record<ParameterType, [number, number]>> = {
  uint8: [0, 255],
  int8: [-128, 127],
  uint16: [0, 65535],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
};

/** The value a Device of this type ends up storing. */
function stored(type: ParameterType, value: number): number {
  return type === "float" ? Math.fround(value) : value;
}

/**
 * Reads, writes and enumerates one Device's Device Parameters over its running Source.
 * Framing-independent: Messages come from the Frame Format's ParameterProtocol.
 * Nothing here runs on its own; every exchange is started by an explicit request (ADR-0008).
 */
export class ParameterClient {
  /** Where requests go: the node that sends us Messages (broadcast until one is seen). */
  private target: NodeAddress = { system: 0, component: 0 };
  /** Last report per name, for types and enumeration indices. */
  private readonly known = new Map<string, DeviceParameter>();
  private readonly listeners = new Set<(r: ParameterReport) => void>();

  constructor(
    private readonly protocol: ParameterProtocol,
    private readonly send: (m: OutgoingMessage) => void,
    private readonly onParameter: (p: DeviceParameter) => void,
  ) {}

  /** Feeds every decoded Message from the Device. */
  observe(msg: DecodedMessage): void {
    if (msg.sender) this.target = msg.sender;
    const r = this.protocol.report(msg);
    if (!r) return;
    const p: DeviceParameter = { name: r.name, value: r.value, type: r.type, index: r.index >= 0 ? r.index : (this.known.get(r.name)?.index ?? -1) };
    this.known.set(p.name, p);
    this.onParameter(p);
    for (const l of this.listeners) l(r);
  }

  async read(name: string): Promise<DeviceParameter> {
    this.checkName(name);
    await this.exchange(() => this.protocol.requestRead(this.target, name), (r) => r.name === name, `reading ${name}`);
    return this.known.get(name)!;
  }

  async write(name: string, value: number): Promise<{ parameter: DeviceParameter; accepted: boolean }> {
    this.checkName(name);
    const type = (this.known.get(name) ?? (await this.read(name))).type;
    const range = INTEGER_RANGE[type];
    if (range && !(Number.isInteger(value) && value >= range[0] && value <= range[1])) {
      throw new ProtocolFailure("invalid_params", `${name} is ${type}: ${value} is not a valid value`);
    }
    await this.exchange(() => this.protocol.requestWrite(this.target, name, value, type), (r) => r.name === name, `writing ${name}`);
    const parameter = this.known.get(name)!;
    return { parameter, accepted: parameter.value === stored(type, value) };
  }

  async list(): Promise<Omit<ParameterList, "device">> {
    const seen = new Map<number, DeviceParameter>();
    let count = -1;
    let last = 0;
    const listener = (r: ParameterReport) => {
      if (r.index < 0) return;
      count = r.count;
      seen.set(r.index, this.known.get(r.name)!);
      last = performance.now();
    };
    const missing = () => Array.from({ length: Math.max(count, 0) }, (_, i) => i).filter((i) => !seen.has(i));
    /** Waits until everything has arrived or the Device has gone quiet. */
    const settle = async () => {
      last = performance.now();
      while (!(count >= 0 && missing().length === 0) && performance.now() - last < ATTEMPT_MS) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    this.listeners.add(listener);
    try {
      for (let i = 0; i < ATTEMPTS && count < 0; i++) {
        this.send(this.protocol.requestList(this.target));
        await settle();
      }
      if (count < 0) throw new ProtocolFailure("timeout", "The Device did not report any Device Parameters");
      for (let i = 0; i < ATTEMPTS && missing().length; i++) {
        for (const index of missing()) this.send(this.protocol.requestRead(this.target, index));
        await settle();
      }
      return { parameters: [...seen.values()].sort((a, b) => a.index - b.index), count, missing: missing() };
    } finally {
      this.listeners.delete(listener);
    }
  }

  private checkName(name: string): void {
    if (name.length > this.protocol.maxNameLength) {
      throw new ProtocolFailure("invalid_params", `Device Parameter names have at most ${this.protocol.maxNameLength} characters`);
    }
  }

  /** Sends a request until a matching report arrives, retrying a few times. */
  private exchange(request: () => OutgoingMessage, match: (r: ParameterReport) => boolean, what: string): Promise<ParameterReport> {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout>;
      const listener = (r: ParameterReport) => {
        if (!match(r)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(r);
      };
      const tryOnce = () => {
        if (attempt++ === ATTEMPTS) {
          this.listeners.delete(listener);
          reject(new ProtocolFailure("timeout", `No answer from the Device ${what} after ${ATTEMPTS} attempts`));
          return;
        }
        this.send(request());
        timer = setTimeout(tryOnce, ATTEMPT_MS);
      };
      this.listeners.add(listener);
      tryOnce();
    });
  }
}
