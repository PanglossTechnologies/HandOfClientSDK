export type MountErrorReason =
  | "token-fetch-failed"
  | "no-active-version"
  | "iframe-load-failed"
  | "timeout"
  | "plugin-error"
  | "resolve-failed"
  | "no-slot"
  | "inject-load-failed"
  | "csp-blocked";

export class HocMountError extends Error {
  constructor(public readonly reason: MountErrorReason, message: string) {
    super(message);
    this.name = "HocMountError";
  }
}
