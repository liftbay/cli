export type AppleAuthErrorCode = "bad_credentials" | "locked" | "2fa_failed" | "api_access_not_enabled" | "not_admin" | "agreement_required" | "unexpected";

export class AppleAuthError extends Error {
  constructor(
    readonly code: AppleAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppleAuthError";
  }
}
