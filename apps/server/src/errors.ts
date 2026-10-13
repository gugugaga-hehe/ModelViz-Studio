import type { ErrorCode } from "@modelviz/protocol";

/** An error that is reported to the client verbatim through the protocol. */
export class ProtocolFailure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
