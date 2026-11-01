"use client";

import { createContext, type ReactNode, useContext } from "react";

const ClosedSignupLabel = createContext<string | null>(null);

/** The server owns availability. Null preserves the existing open-state CTA. */
export function SignupAvailability({
  closedLabel,
  children,
}: {
  closedLabel: string | null;
  children: ReactNode;
}) {
  return <ClosedSignupLabel.Provider value={closedLabel}>{children}</ClosedSignupLabel.Provider>;
}

export function useClosedSignupLabel() {
  return useContext(ClosedSignupLabel);
}
