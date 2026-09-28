import { expect, it } from "vitest";
import { type Env, umamiFunnel } from "../src/env.js";

const ENDPOINT = "https://umami.example.com/api/send";
const WEBSITE = "167a3266-4a56-4fd1-8d14-59ed7437a313";

// Only the fields the policy reads; the zod schema is not under test.
const withEnv = (overrides: Record<string, unknown>) =>
  ({ UMAMI_ENDPOINT: undefined, UMAMI_WEBSITE_ID: undefined, ...overrides }) as unknown as Env;

/**
 * The regression this file exists for (card t_47d43fde): the server-side
 * funnel used to fall back to the hosted Umami whenever IS_CLOUD was true, so
 * a dev box and the web test suite (which stubs IS_CLOUD=true by the dozen)
 * emitted into production. A deployment that configured no collector must
 * emit NOTHING — never the hosted instance, never an implicit one.
 */
it("emits nowhere when the environment configured no collector, cloud or not", () => {
  expect(umamiFunnel(withEnv({}))).toEqual({ endpoint: null, websiteId: null });
  expect(umamiFunnel(withEnv({ IS_CLOUD: true }))).toEqual({ endpoint: null, websiteId: null });
  expect(umamiFunnel(withEnv({ IS_CLOUD: true, NODE_ENV: "production" }))).toEqual({
    endpoint: null,
    websiteId: null,
  });
});

it("sends to exactly the endpoint/website pair this environment set", () => {
  expect(umamiFunnel(withEnv({ UMAMI_ENDPOINT: ENDPOINT, UMAMI_WEBSITE_ID: WEBSITE }))).toEqual({
    endpoint: ENDPOINT,
    websiteId: WEBSITE,
  });
});

// Half a pair is not a collector: a typo'd UMAMI_ENDPOINT must not send the
// event somewhere the operator cannot see.
it("treats a half-configured pair as unconfigured", () => {
  expect(umamiFunnel(withEnv({ UMAMI_ENDPOINT: ENDPOINT }))).toEqual({
    endpoint: null,
    websiteId: null,
  });
  expect(umamiFunnel(withEnv({ UMAMI_WEBSITE_ID: WEBSITE }))).toEqual({
    endpoint: null,
    websiteId: null,
  });
  // Under SKIP_ENV_VALIDATION an empty variable reaches the proxy as "".
  expect(umamiFunnel(withEnv({ UMAMI_ENDPOINT: "", UMAMI_WEBSITE_ID: "" }))).toEqual({
    endpoint: null,
    websiteId: null,
  });
});
