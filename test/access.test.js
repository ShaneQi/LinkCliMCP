import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { accessConfig, accessToken, clearAccessKeys, setAccessKeys, verifyAccessJwt } from "../src/access.js";
import { ACCESS_ENV, AUD, ISSUER, KEY, installTestKeys, newKeyPair, publicJwk, signToken, validToken } from "./access-helper.js";

const realFetch = globalThis.fetch;
const realNow = Date.now;
const CONFIG = accessConfig(ACCESS_ENV);

beforeEach(async () => {
  clearAccessKeys();
  await installTestKeys();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

// A request to /mcp with the given headers; ping needs no link-cli.
async function ping(headers, env = ACCESS_ENV) {
  const res = await worker.fetch(new Request("https://origin.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }), env);
  return { status: res.status, auth: res.headers.get("WWW-Authenticate"), text: await res.text() };
}
const viaHeader = (t) => ping({ "Cf-Access-Jwt-Assertion": t });
const viaBearer = (t) => ping({ Authorization: `Bearer ${t}` });

async function rejected(token, reason) {
  const r = await viaHeader(token);
  assert.equal(r.status, 401);
  assert.equal(r.auth, "Bearer");
  assert.equal(r.text, "Unauthorized\n", "the reason is not sent to the client");
  await assert.rejects(verifyAccessJwt(token, CONFIG), new RegExp(reason));
}

test("a valid token passes, via Cf-Access-Jwt-Assertion and via Authorization: Bearer", async () => {
  const t = await validToken();
  assert.equal((await viaHeader(t)).status, 200);
  assert.equal((await viaBearer(t)).status, 200);
  const payload = await verifyAccessJwt(t, CONFIG);
  assert.equal(payload.email, "user@example.com");
});

test("aud may be a string, and any configured AUD tag matches", async () => {
  assert.equal((await viaHeader(await validToken({ aud: AUD }))).status, 200);
  const env = { ...ACCESS_ENV, CF_ACCESS_AUD: `other-app, ${AUD}` };
  assert.equal((await ping({ "Cf-Access-Jwt-Assertion": await validToken({ aud: ["x", AUD] }) }, env)).status, 200);
});

test("exp and nbf allow 60 s of clock skew", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await viaHeader(await validToken({ exp: now - 30 }))).status, 200);
  assert.equal((await viaHeader(await validToken({ nbf: now + 30 }))).status, 200);
});

test("rejected: expired", async () => {
  await rejected(await validToken({ exp: Math.floor(Date.now() / 1000) - 120 }), "expired");
  await rejected(await validToken({ exp: undefined }), "expired");
});

test("rejected: nbf in the future", async () => {
  await rejected(await validToken({ nbf: Math.floor(Date.now() / 1000) + 600 }), "not yet valid");
});

test("rejected: wrong aud", async () => {
  await rejected(await validToken({ aud: ["someone-else"] }), "wrong audience");
  await rejected(await validToken({ aud: undefined }), "wrong audience");
});

test("rejected: wrong iss", async () => {
  await rejected(await validToken({ iss: "https://evil.cloudflareaccess.com" }), "wrong issuer");
});

test("rejected: unknown kid", async () => {
  await rejected(await signToken(KEY, {}, { kid: "k9" }), "unknown signing key");
});

test("rejected: signed by a different key", async () => {
  await rejected(await signToken(await newKeyPair()), "bad signature");
});

test("rejected: tampered payload", async () => {
  const [h, , s] = (await validToken()).split(".");
  const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: [AUD], exp: 9999999999, email: "admin@example.com" })).toString("base64url");
  await rejected(`${h}.${forged}.${s}`, "bad signature");
});

test("rejected: not RS256, or not a JWT", async () => {
  await rejected(await signToken(KEY, {}, { alg: "none" }), "unexpected alg none");
  await rejected("abc.def", "not a JWT");
  await rejected("!!!.!!!.!!!", "malformed JWT");
});

test("rejected: no token", async () => {
  const r = await ping({});
  assert.equal(r.status, 401);
  assert.equal(r.auth, "Bearer");
  assert.equal((await ping({ Authorization: "Basic dXNlcjpwYXNz" })).status, 401);
});

test("missing CF_ACCESS_* settings → 500", async () => {
  const t = await validToken();
  for (const env of [{}, { CF_ACCESS_TEAM_DOMAIN: ACCESS_ENV.CF_ACCESS_TEAM_DOMAIN }, { CF_ACCESS_AUD: AUD }, { ...ACCESS_ENV, CF_ACCESS_AUD: " , " }]) {
    const r = await ping({ "Cf-Access-Jwt-Assertion": t }, env);
    assert.equal(r.status, 500);
    assert.match(r.text, /CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/);
  }
});

test("health and the root page need no token", async () => {
  assert.equal((await worker.fetch(new Request("https://origin.example/"), {})).status, 200);
  assert.equal((await worker.fetch(new Request("https://origin.example/other"), ACCESS_ENV)).status, 404);
});

test("team domain forms", () => {
  for (const team of ["myteam", "myteam.cloudflareaccess.com", "https://myteam.cloudflareaccess.com/", " myteam.cloudflareaccess.com "]) {
    assert.equal(accessConfig({ CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: "a" }).issuer, "https://myteam.cloudflareaccess.com");
  }
  assert.deepEqual(accessConfig({ CF_ACCESS_TEAM_DOMAIN: "t", CF_ACCESS_AUD: "a, b ,," }).audiences, ["a", "b"]);
  assert.equal(accessConfig({ CF_ACCESS_TEAM_DOMAIN: "t" }), null);
});

test("token source: the Access header wins over Authorization", () => {
  const req = (h) => new Request("https://x/mcp", { headers: h });
  assert.equal(accessToken(req({ "Cf-Access-Jwt-Assertion": " a.b.c ", Authorization: "Bearer x.y.z" })), "a.b.c");
  assert.equal(accessToken(req({ Authorization: "bearer x.y.z" })), "x.y.z");
  assert.equal(accessToken(req({})), null);
});

test("keys are fetched from the team's certs endpoint and cached", async () => {
  clearAccessKeys();
  const fetched = [];
  const jwks = { keys: [await publicJwk(KEY, "k1")] };
  globalThis.fetch = async (url) => { fetched.push(String(url)); return Response.json(jwks); };
  const t = await validToken();
  await verifyAccessJwt(t, CONFIG);
  await verifyAccessJwt(t, CONFIG);
  assert.deepEqual(fetched, [`${ISSUER}/cdn-cgi/access/certs`]);

  // After an hour the keys are re-fetched.
  const start = realNow();
  Date.now = () => start + 61 * 60_000;
  await verifyAccessJwt(t, CONFIG, Date.now() / 1000 - 3000);
  assert.equal(fetched.length, 2);
});

test("an unknown kid re-fetches the keys, at most once a minute (key rotation)", async () => {
  const rotated = await newKeyPair();
  const jwks = { keys: [await publicJwk(KEY, "k1"), await publicJwk(rotated, "k2")] };
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return Response.json(jwks); };
  const t2 = await signToken(rotated, {}, { kid: "k2" });

  // Keys were just installed: no re-fetch yet.
  await assert.rejects(verifyAccessJwt(t2, CONFIG), /unknown signing key/);
  assert.equal(fetches, 0);

  const start = realNow();
  Date.now = () => start + 90_000;
  await verifyAccessJwt(t2, CONFIG);
  assert.equal(fetches, 1);
  // A second unknown kid right after does not fetch again.
  await assert.rejects(verifyAccessJwt(await signToken(KEY, {}, { kid: "k3" }), CONFIG), /unknown signing key/);
  assert.equal(fetches, 1);
});

test("a failed refresh keeps using cached keys; with none cached the request is refused", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const start = realNow();
  Date.now = () => start + 2 * 60 * 60_000;
  const t = await validToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await verifyAccessJwt(t, CONFIG);

  clearAccessKeys();
  await assert.rejects(verifyAccessJwt(t, CONFIG), /could not fetch Cloudflare Access keys .*HTTP 503/);
  assert.equal((await viaHeader(t)).status, 401);
});

test("setAccessKeys ignores non-RSA keys and keys without kid", async () => {
  clearAccessKeys();
  await setAccessKeys(ISSUER, { keys: [{ kty: "EC", kid: "e1" }, { ...(await publicJwk(KEY, "k1")), kid: undefined }] });
  await assert.rejects(verifyAccessJwt(await validToken(), CONFIG), /unknown signing key/);
});

test("rejected: empty kid in the header", async () => {
  await rejected(await signToken(KEY, {}, { kid: "" }), "missing kid");
});

test("requests that need new keys at the same time share one fetch, with a timeout", async () => {
  clearAccessKeys();
  const jwks = { keys: [await publicJwk(KEY, "k1")] };
  let fetches = 0;
  let signal;
  globalThis.fetch = async (_url, init) => {
    fetches++;
    signal = init?.signal;
    await new Promise((r) => setTimeout(r, 20));
    return Response.json(jwks);
  };
  const t = await validToken();
  await Promise.all([verifyAccessJwt(t, CONFIG), verifyAccessJwt(t, CONFIG), verifyAccessJwt(t, CONFIG)]);
  assert.equal(fetches, 1);
  assert.ok(signal instanceof AbortSignal, "the key fetch is given a timeout signal");
});
