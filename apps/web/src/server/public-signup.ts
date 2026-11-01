import "server-only";
import { signupOpen } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { APIError } from "better-auth/api";
import { cache } from "react";
import { assertSignupAllowed } from "./auth";

export type PublicSignupAvailability = "open" | "paused" | "full";

/** Request-local UI hint only. The unchanged auth hooks still enforce admission. */
export const publicSignupAvailability = cache(async (): Promise<PublicSignupAvailability> => {
  try {
    await assertSignupAllowed(getDb(), signupOpen());
    return "open";
  } catch (error) {
    if (error instanceof APIError && error.status === "FORBIDDEN") {
      if (error.body?.message === "Signup is disabled.") return "paused";
      if (error.body?.message === "Beta is full.") return "full";
    }
    // A database/config failure is NOT evidence that signup is open (or paused).
    throw error;
  }
});
