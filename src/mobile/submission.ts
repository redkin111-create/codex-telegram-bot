/** A server-confirmed refusal before Codex accepted a mobile submission. */
export class MobileSubmissionRejectedError extends Error {
  readonly submissionOutcome = "rejected" as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MobileSubmissionRejectedError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function isMobileSubmissionRejectedError(error: unknown): error is MobileSubmissionRejectedError {
  return error instanceof MobileSubmissionRejectedError;
}
