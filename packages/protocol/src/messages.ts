import { z } from "zod";
import { ProjectInfo, ProjectTemplate } from "./project.ts";
import { DeviceInfo, SignalInfo, SourceState } from "./signals.ts";

/**
 * Version of the client protocol. Client and server must agree exactly;
 * bump on any incompatible change to the messages below.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the server accepts client connections on. */
export const PROTOCOL_PATH = "/ws";

export const ErrorCode = z.enum([
  "protocol_version_mismatch",
  "bad_message",
  "unknown_method",
  "invalid_params",
  "not_found",
  "conflict",
  "already_exists",
  "invalid_project",
  "no_project",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolError = z.object({
  code: ErrorCode,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

// ---- Methods (request → result) -------------------------------------------

export const Methods = {
  "project.create": {
    params: z.object({
      path: z.string().min(1),
      name: z.string().min(1),
      template: ProjectTemplate.default("empty"),
    }),
    result: ProjectInfo,
  },
  "project.open": {
    params: z.object({ path: z.string().min(1) }),
    result: ProjectInfo,
  },
  "project.current": {
    params: z.object({}),
    result: ProjectInfo.nullable(),
  },
  "devices.list": {
    params: z.object({}),
    result: z.array(DeviceInfo),
  },
  "signals.list": {
    params: z.object({}),
    result: z.array(SignalInfo),
  },
  /** Start streaming binary chunks for these Signal ids to this client. */
  "signals.subscribe": {
    params: z.object({ ids: z.array(z.string()) }),
    result: z.object({}),
  },
  "signals.unsubscribe": {
    params: z.object({ ids: z.array(z.string()) }),
    result: z.object({}),
  },
  "sources.list": {
    params: z.object({}),
    result: z.array(SourceState),
  },
  "source.startVirtual": {
    params: z.object({ device: z.string() }),
    result: SourceState,
  },
  "source.stop": {
    params: z.object({ device: z.string() }),
    result: SourceState,
  },
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]["result"]>;

// ---- Events (server → client, unsolicited) --------------------------------

export const Events = {
  "project.changed": ProjectInfo.nullable(),
  "source.changed": SourceState,
} as const;

export type EventName = keyof typeof Events;
export type EventData<E extends EventName> = z.infer<(typeof Events)[E]>;

// ---- Envelopes -------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocolVersion: z.number().int() }),
  z.object({
    type: z.literal("request"),
    id: z.number().int(),
    method: z.string(),
    params: z.unknown(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.union([
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.number().int(),
    serverVersion: z.string(),
  }),
  z.object({ type: z.literal("fatal"), error: ProtocolError }),
  z.object({ type: z.literal("response"), id: z.number().int(), result: z.unknown() }),
  z.object({ type: z.literal("response"), id: z.number().int(), error: ProtocolError }),
  z.object({ type: z.literal("event"), event: z.string(), data: z.unknown() }),
]);
export type ServerMessage =
  | { type: "welcome"; protocolVersion: number; serverVersion: string }
  | { type: "fatal"; error: ProtocolError }
  | { type: "response"; id: number; result: unknown }
  | { type: "response"; id: number; error: ProtocolError }
  | { type: "event"; event: string; data: unknown };
