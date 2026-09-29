import { describe, expect, it } from "vitest";
import { signupFieldMismatch } from "@/lib/signup-validation";

describe("signup field mismatch", () => {
  const base = {
    email: "ana@example.com",
    confirmEmail: "ana@example.com",
    password: "supersecret",
    confirmPassword: "supersecret",
  };

  it("passes when both confirmations match", () => {
    expect(signupFieldMismatch(base)).toBeNull();
  });

  it("flags a different email", () => {
    expect(signupFieldMismatch({ ...base, confirmEmail: "ana@exemple.com" })).toBe("emailMismatch");
  });

  it("flags a different password", () => {
    expect(signupFieldMismatch({ ...base, confirmPassword: "supersecre" })).toBe(
      "passwordMismatch",
    );
  });

  it("reports the email mismatch first, before the password one", () => {
    expect(
      signupFieldMismatch({
        ...base,
        confirmEmail: "outra@example.com",
        confirmPassword: "different",
      }),
    ).toBe("emailMismatch");
  });

  it("ignores surrounding whitespace and email case", () => {
    expect(
      signupFieldMismatch({ ...base, email: " Ana@Example.com ", confirmEmail: "ana@example.com" }),
    ).toBeNull();
  });
});
