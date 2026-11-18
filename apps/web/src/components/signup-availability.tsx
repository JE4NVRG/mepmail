"use client";

import { createContext, type ReactNode, useContext } from "react";

const SignupLabels = createContext<{ closedLabel: string | null; freeLabel: string | null }>({
  closedLabel: null,
  freeLabel: null,
});

/** The server owns availability. Null preserves the existing open-state CTA. */
export function SignupAvailability({
  closedLabel,
  freeLabel = null,
  children,
}: {
  closedLabel: string | null;
  freeLabel?: string | null;
  children: ReactNode;
}) {
  return <SignupLabels.Provider value={{ closedLabel, freeLabel }}>{children}</SignupLabels.Provider>;
}

export function useSignupLabels() {
  return useContext(SignupLabels);
}

export function useClosedSignupLabel() {
  return useSignupLabels().closedLabel;
}
