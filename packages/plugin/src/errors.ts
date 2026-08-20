export const SAFE_MODEL_ERRORS = Object.freeze({
  INVALID_CONFIG: "Agent Bus configuration is invalid.",
  INVALID_CREDENTIAL: "Agent Bus credentials are unavailable.",
  INVALID_REQUEST: "Agent Bus request is invalid.",
  INVALID_RESPONSE: "Agent Bus response validation failed.",
  UNAVAILABLE: "Agent Bus is unavailable.",
  OPERATION_FAILED: "Agent Bus could not complete the operation.",
  RECEIVE_DENIED: "Agent Bus receive was not approved; the message remains pending.",
} as const);

export class SafeModelError extends Error {
  constructor(message: (typeof SAFE_MODEL_ERRORS)[keyof typeof SAFE_MODEL_ERRORS]) {
    super(message);
    this.name = "SafeModelError";
  }
}

export function asSafeModelError(error: unknown): SafeModelError {
  return error instanceof SafeModelError
    ? error
    : new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
}
