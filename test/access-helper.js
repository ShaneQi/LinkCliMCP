// Test helper: an RSA-2048 key pair installed as the Cloudflare Access key
// set of a fake team, and a signer for Access-style JWTs.
import { setAccessKeys } from "../src/access.js";

export const TEAM = "test-team.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const AUD = "test-aud-tag";
export const ACCESS_ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

const ALG = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export const newKeyPair = () => crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);

export async function publicJwk(keyPair, kid) {
  const { kty, n, e } = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { kty, n, e, kid, alg: "RS256", use: "sig" };
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** Signs { iss, aud, exp, ...claims } with keyPair; header kid defaults to "k1". */
export async function signToken(keyPair, claims = {}, { kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, aud: [AUD], iat: now, exp: now + 3600, sub: "user-1", email: "user@example.com", ...claims };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const input = `${b64urlJson({ alg, kid, typ: "JWT" })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** The test team's key: generated once, installed with kid "k1". */
export const KEY = await newKeyPair();
export async function installTestKeys() {
  await setAccessKeys(ISSUER, { keys: [await publicJwk(KEY, "k1")] });
}
export const validToken = (claims) => signToken(KEY, claims);
