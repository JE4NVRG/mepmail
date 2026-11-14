import type { SystemMailKind } from "./system-mail.js";

/** In-process producer capability; JSON payloads cannot supply this symbol. */
export const SYSTEM_MAIL_ORIGIN = Symbol("system-mail-origin");

/** Sealed inside the body, never returned by the public body reader. */
export type EmailBodyOrigin =
  | { version: 1; source: "customer" }
  | {
      version: 1;
      source: "system";
      kind: SystemMailKind;
      from: string;
      to: string[];
      subject: string;
    };
