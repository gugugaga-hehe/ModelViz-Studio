import type { SourceKind, SourceState, SourceStatus, TransportConfig } from "@modelviz/protocol";
import { DeviceLink, type Publish, type SignalTarget } from "./device-link.ts";
import type { FrameFormat } from "./frame-format.ts";
import { type Transport, createTransport } from "./transports.ts";
import { VirtualDevice } from "./virtual-device.ts";
import type { VirtualDeviceConfig } from "@modelviz/protocol";

/** How long to wait for the Device's dialect hash after connecting (ms). */
export const DIALECT_CHECK_TIMEOUT_MS = 5000;

export interface SourceOptions {
  device: string;
  format: FrameFormat;
  targets: Map<string, SignalTarget[]>;
  publish: Publish;
  onState(state: SourceState): void;
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

  private constructor(
    readonly kind: SourceKind,
    private readonly opts: SourceOptions,
    readonly transport?: TransportConfig,
  ) {
    const { format } = opts;
    this.link = new DeviceLink(
      opts.device,
      format,
      opts.targets,
      opts.publish,
      format.dialectCheck
        ? {
            check: format.dialectCheck,
            expectedHash: format.dialectHash,
            onResult: (ok, received) => {
              this.clearCheckTimer();
              if (ok) this.set("running");
              else this.reject(`Dialect hash mismatch: Device reports ${received}, Frame Format expects ${format.dialectHash}`);
            },
          }
        : undefined,
    );
  }

  static virtual(opts: SourceOptions, config: VirtualDeviceConfig): ActiveSource {
    const src = new ActiveSource("virtual", opts);
    const vd = new VirtualDevice(opts.format, config, (bytes) => src.link.ingest(bytes));
    src.stopTarget = () => vd.stop();
    src.connected();
    vd.start();
    return src;
  }

  static live(opts: SourceOptions, config: TransportConfig): ActiveSource {
    const src = new ActiveSource(config.kind, opts, config);
    const transport: Transport = createTransport(config, {
      onData: (bytes) => src.link.ingest(bytes),
      onStatus: (status, error) => {
        if (status === "connected") src.connected();
        else {
          src.clearCheckTimer();
          src.set(status, error);
        }
      },
    });
    src.stopTarget = () => transport.stop();
    transport.start();
    return src;
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
    };
  }

  stop(): void {
    this.clearCheckTimer();
    this.stopTarget?.();
    this.stopTarget = null;
    this.set("stopped");
  }

  private connected(): void {
    if (!this.opts.format.dialectCheck) {
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

  private reject(error: string): void {
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
