import { expect, it } from "vitest";
import { assertEnvConsistency, customerSmtpRelay, type Env } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

const URL_SET = { CUSTOMER_SMTP_RELAY_URL: "smtps://user:secret@smtp.azurecomm.net:465" };

it("is off while CUSTOMER_SMTP_RELAY_URL is unset", () => {
  expect(customerSmtpRelay(fakeEnv({}))).toBeNull();
  expect(() => assertEnvConsistency(fakeEnv({}))).not.toThrow();
});

it("takes an smtp:// or smtps:// URL, named by CUSTOMER_SMTP_RELAY_NAME or the relay's host", () => {
  expect(customerSmtpRelay(fakeEnv(URL_SET))).toEqual({
    url: URL_SET.CUSTOMER_SMTP_RELAY_URL,
    name: "smtp.azurecomm.net",
  });
  expect(customerSmtpRelay(fakeEnv({ ...URL_SET, CUSTOMER_SMTP_RELAY_NAME: "azure" }))?.name).toBe(
    "azure",
  );
  expect(
    customerSmtpRelay(
      fakeEnv({
        CUSTOMER_SMTP_RELAY_URL: "smtp://relay.example.com:587",
        CUSTOMER_SMTP_RELAY_NAME: "oci",
      }),
    ),
  ).toEqual({ url: "smtp://relay.example.com:587", name: "oci" });
  expect(() =>
    assertEnvConsistency(fakeEnv({ ...URL_SET, CUSTOMER_SMTP_RELAY_NAME: "oci" })),
  ).not.toThrow();
});

it("refuses a URL of another scheme, or none at all", () => {
  for (const url of ["https://smtp.example.com", "not a url"]) {
    expect(customerSmtpRelay(fakeEnv({ CUSTOMER_SMTP_RELAY_URL: url }))).toBeNull();
    expect(() => assertEnvConsistency(fakeEnv({ CUSTOMER_SMTP_RELAY_URL: url }))).toThrow(
      "CUSTOMER_SMTP_RELAY_URL must be an smtp:// or smtps:// URL",
    );
  }
});

it("refuses a name without the URL, and a name a message id cannot carry", () => {
  expect(() => assertEnvConsistency(fakeEnv({ CUSTOMER_SMTP_RELAY_NAME: "azure" }))).toThrow(
    "CUSTOMER_SMTP_RELAY_NAME requires CUSTOMER_SMTP_RELAY_URL",
  );
  expect(() =>
    assertEnvConsistency(fakeEnv({ ...URL_SET, CUSTOMER_SMTP_RELAY_NAME: "azure: east" })),
  ).toThrow("CUSTOMER_SMTP_RELAY_NAME must be");
});
