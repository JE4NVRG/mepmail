import Stripe from "stripe";
import { expect, it } from "vitest";
import { isMissingStripeCustomer } from "../src/stripe.js";

/** Builds the error the SDK throws for a 400 error body, the way its request sender does. */
function stripeError(raw: { code: string; param?: string; message: string }) {
  return Stripe.errors.StripeError.generate({
    type: "invalid_request_error",
    statusCode: 400,
    ...raw,
  });
}

it("recognizes Stripe's answer that the request's customer does not exist", () => {
  const err = stripeError({
    code: "resource_missing",
    param: "customer",
    message:
      "No such customer: 'cus_x'; a similar object exists in test mode, but a live mode key was used to make this request.",
  });
  // The class the worker logged for a test-mode customer under the live key.
  expect(err.type).toBe("StripeInvalidRequestError");
  expect(isMissingStripeCustomer(err)).toBe(true);
});

it("leaves every other error to the caller", () => {
  expect(
    isMissingStripeCustomer(
      stripeError({
        code: "resource_missing",
        param: "id",
        message: "No such subscription: 'sub_x'",
      }),
    ),
  ).toBe(false);
  expect(
    isMissingStripeCustomer(
      stripeError({ code: "parameter_invalid_empty", param: "customer", message: "empty" }),
    ),
  ).toBe(false);
  expect(isMissingStripeCustomer(new Error("No such customer: 'cus_x'"))).toBe(false);
  expect(isMissingStripeCustomer(null)).toBe(false);
  expect(isMissingStripeCustomer("resource_missing")).toBe(false);
});
