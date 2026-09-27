/**
 * Signup-only field checks that run before the request: the two email entries
 * must match each other and the two password entries must match as well.
 * Returns the catalog key of the first mismatch, or null when the form is
 * consistent. The server still owns format, length and policy checks.
 */
export type SignupMismatch = "emailMismatch" | "passwordMismatch";

export function signupFieldMismatch(input: {
  email: string;
  confirmEmail: string;
  password: string;
  confirmPassword: string;
}): SignupMismatch | null {
  // Email compare is case- and whitespace-forgiving; addresses are
  // case-insensitive in practice and the extra strictness only annoys.
  if (input.confirmEmail.trim().toLowerCase() !== input.email.trim().toLowerCase()) {
    return "emailMismatch";
  }
  if (input.confirmPassword !== input.password) {
    return "passwordMismatch";
  }
  return null;
}
