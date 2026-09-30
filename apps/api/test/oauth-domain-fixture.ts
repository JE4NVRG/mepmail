import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** Ephemeral test key only; never reads the persisted production signing keys. */
export async function foreignClaimsFixture(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...(await exportJWK(publicKey)), kid: "domain-negative-fixture", alg: "EdDSA" };
  return {
    jwk,
    sign: (override: Record<string, unknown>) =>
      new SignJWT({ ...claims, ...override })
        .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid, typ: "at+jwt" })
        .sign(privateKey),
  };
}
