import { ADVERTISING_PUBLIC_PATHS, publicAdvertisingSource } from "@millionsend/billing";
import { expect, it } from "vitest";
import { META_PUBLIC_PATHS } from "@/lib/meta-public-events";

it("the pages that load the tags are the pages a consent's events may come from", () => {
  // A consent given on a page missing here would drop that visitor's server-side
  // events (checkout, purchase, sign-up): an ad landing there would lose its results.
  expect([...META_PUBLIC_PATHS].sort()).toEqual([...ADVERTISING_PUBLIC_PATHS].sort());
  for (const path of META_PUBLIC_PATHS)
    expect(publicAdvertisingSource(`https://mepmail.dev${path}?utm_source=ig#plans`)).toBe(
      `https://mepmail.dev${path}`,
    );
});
