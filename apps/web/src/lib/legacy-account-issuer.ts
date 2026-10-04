/** Keep future accounts readable by the preserved Better Auth 1.7.2 artifact. */
export function legacyAccountIssuer(providerId: string): string {
  switch (providerId) {
    case "credential":
      return "local:credential";
    case "google":
      return "https://accounts.google.com";
    case "github":
      return "local:oauth:github";
    default:
      throw new Error("Unsupported account provider");
  }
}
