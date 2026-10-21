export class MobileApiError extends Error {
  constructor(message: string, readonly status: number, readonly submissionOutcome?: "rejected") {
    super(message);
    this.name = "MobileApiError";
  }
}

export function mobileApiErrorFromPayload(message: string, status: number, payload: unknown): MobileApiError {
  const submissionOutcome = payload && typeof payload === "object" && !Array.isArray(payload) &&
    (payload as Record<string, unknown>).submissionOutcome === "rejected" ? "rejected" : undefined;
  return new MobileApiError(message, status, submissionOutcome);
}

export function isConfirmedMobileSubmissionRejection(error: unknown): error is MobileApiError {
  return error instanceof MobileApiError && error.submissionOutcome === "rejected";
}

export function mobileSubmissionOutcome(error: unknown): "rejected" | "uncertain" {
  return isConfirmedMobileSubmissionRejection(error) ? "rejected" : "uncertain";
}
