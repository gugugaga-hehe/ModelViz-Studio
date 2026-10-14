import type { DeviceParameter, SourceKind, SourceState, SourceStatus, TransportConfig } from "@modelviz/protocol";
import { ParameterClient } from "./device-parameters.ts";
import { DeviceLink, type Publish, type SignalTarget } from "./device-link.ts";
import type { FrameFormat } from "./frame-format.ts";
import { type Transport, createTransport } from "./transports.ts";
import type { Recorder, RecordingReader } from "./recording.ts";
import { ReplayPlayer } from "./replay.ts";
import { VirtualDevice } from "./virtual-device.ts";
import type { VirtualDeviceConfig } from "@modelviz/protocol";

/** How long to wait for the Device's dialect hash after connecting (ms). */
export const DIALECT_CHECK_TIMEOUT_MS = 5000;

/** Address the workbench sends from, as a ground station would. */
const WORKBENCH_ADDRESS = { system: 255, component: 190 };

export interface SourceOptions {
  device: string;
  format: FrameFormat;
  targets: Map<string, SignalTarget[]>;
  publish: Publish;
  onState(state: SourceState): void;
  /** Downstream Signals restart (Log Replay seek). */
  onReset?(): void;
  /** The Device reported a Device Parameter. */
  onParameter?(p: DeviceParameter): void;
}

/**
 * One running Source for a Device: a live Transport or a Virtual Device feeding a DeviceLink.
 * Owns the connection state machine and the dialect check (ADR-0009).
 */
export class ActiveSource {
  readonly link: DeviceLink;
  private status: SourceStatus = "connecting";
  private error: string | undefined;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTarget: (() => void) | null = null;
  private player: ReplayPlayer<{ time: number; bytes: Uint8Array }> | null = null;
  /** Raw-byte tap for an in-progress Recording. */
  recorder: Recorder | null = null;
  /** Dialect hash the Device reported in the last successful check. */
  verifiedHash: string | null = null;
  /** Device Parameter access; null when the Framing has none or the Source cannot send (Log Replay). */
  readonly parameters: ParameterClient | null = null;
  /** Sends bytes to the Device. */
  private sendBytes: ((bytes: Uint8Array) => void) | null = null;

  private constructor(
    readonly kind: SourceKind,
    private readonly opts: SourceOptions,
    readonly transport?: TransportConfig,
    /** Whether the byte stream itself must prove its dialect (not for Log Replays, see replay()). */
    private readonly checkDialect = true,
  ) {
    const { format } = opts;
    if (format.parameters && kind !== "replay") {
      const encoder = format.createEncoder(WORKBENCH_ADDRESS);
      this.parameters = new ParameterClient(
        format.parameters,
        (m) => this.sendBytes?.(encoder.encode(m.message, m.values)),
        (p) => opts.onParameter?.(p),
      );
    }
    this.link = new DeviceLink(
      opts.device,
      format,
      opts.targets,
      opts.publish,
      format.dialectCheck && checkDialect
        ? {
            check: format.dialectCheck,
            expectedHash: format.dialectHash,
            onResult: (ok, received) => {
              this.clearCheckTimer();
              if (ok) this.verifiedHash = received;
              if (ok) this.set("running");
              else this.reject(`Dialect hash mismatch: Device reports ${received}, Frame Format expects ${format.dialectHash}`);
            },
          }
        : undefined,
      this.parameters ? (msg) => this.parameters!.observe(msg) : undefined,
    );
  }

  /** Whether Device Parameters can be exchanged right now. */
  get canExchange(): boolean {
    return this.status === "running" && this.sendBytes !== null;
  }

  static virtual(opts: SourceOptions, config: VirtualDeviceConfig): ActiveSource {
    const src = new ActiveSource("virtual", opts);
    const vd = new VirtualDevice(opts.format, config, (bytes) => src.receive(bytes));
    src.sendBytes = (bytes) => vd.receive(bytes);
    src.stopTarget = () => vd.stop();
    src.connected();
    vd.start();
    return src;
  }

  static live(opts: SourceOptions, config: TransportConfig): ActiveSource {
    const src = new ActiveSource(config.kind, opts, config);
    const transport: Transport = createTransport(config, {
      onData: (bytes) => src.receive(bytes),
      onStatus: (status, error) => {
        if (status === "connected") src.connected();
        else {
          src.clearCheckTimer();
          src.set(status, error);
        }
      },
    });
    src.sendBytes = (bytes) => transport.write(bytes);
    src.stopTarget = () => transport.stop();
    transport.start();
    return src;
  }

  /**
   * Plays a Recording back; bytes are decoded with the current Frame Format (ADR-0007).
   * The dialect was verified when the Recording was made (its hash is in the metadata), and a
   * Recording may start between two hash reports, so the check compares metadata instead.
   */
  static replay(opts: SourceOptions, reader: RecordingReader, speed: number): ActiveSource {
    const recorded = reader.meta.dialectHash;
    if (opts.format.dialectCheck && recorded && recorded !== opts.format.dialectHash) {
      throw new Error(
        `Dialect hash mismatch: Recording ${reader.id} was made with ${recorded}, Frame Format expects ${opts.format.dialectHash}`,
      );
    }
    const src = new ActiveSource("replay", opts, undefined, false);
    let lastBroadcast = 0;
    const player = new ReplayPlayer(
      reader,
      ({ bytes, time }) => {
        src.link!.ingest(bytes, time);
        // progress updates while playing, at a modest rate
        const now = performance.now();
        if (now - lastBroadcast > 250) {
          lastBroadcast = now;
          opts.onState(src.state());
        }
      },
      () => {
        if (player.error) src.reject(`Log Replay failed: ${player.error}`);
        else opts.onState(src.state());
      },
      speed,
    );
    src.player = player;
    src.stopTarget = () => player.stop();
    src.connected();
    player.play();
    return src;
  }

  /** Controls a Log Replay; throws if this Source is not one. */
  control(action: "play" | "pause" | "seek" | "speed", positionMs?: number, speed?: number): void {
    const p = this.player;
    if (!p) throw new Error("Not a Log Replay");
    switch (action) {
      case "play":
        return p.play();
      case "pause":
        return p.pause();
      case "speed":
        if (speed) p.setSpeed(speed);
        return;
      case "seek":
        p.seek(positionMs ?? 0);
        this.link.reset();
        this.opts.onReset?.();
        return;
    }
  }

  private receive(bytes: Uint8Array): void {
    const hostTime = Date.now();
    this.recorder?.write(bytes, hostTime);
    this.link.ingest(bytes, hostTime);
  }

  get active(): boolean {
    return this.status !== "stopped" && this.status !== "rejected";
  }

  state(): SourceState {
    return {
      device: this.opts.device,
      kind: this.kind,
      state: this.status,
      ...(this.transport ? { transport: this.transport } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.player ? { replay: this.player.state() } : {}),
    };
  }

  stop(): void {
    this.clearCheckTimer();
    this.stopTarget?.();
    this.stopTarget = null;
    this.set("stopped");
  }

  private connected(): void {
    if (!this.opts.format.dialectCheck || !this.checkDialect) {
      this.set("running");
      return;
    }
    this.link.reverify();
    this.set("verifying");
    this.clearCheckTimer();
    this.checkTimer = setTimeout(
      () => this.reject(`No dialect hash received within ${DIALECT_CHECK_TIMEOUT_MS / 1000} s`),
      DIALECT_CHECK_TIMEOUT_MS,
    );
  }

  reject(error: string): void {
    this.clearCheckTimer();
    this.stopTarget?.();
    this.stopTarget = null;
    this.set("rejected", error);
  }

  private clearCheckTimer(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private set(status: SourceStatus, error?: string): void {
    if (this.status === "stopped" || (this.status === "rejected" && status !== "stopped")) return;
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.opts.onState(this.state());
  }
}
