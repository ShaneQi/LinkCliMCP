import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { runLinkCli, redact } from "../src/linkcli.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-link-cli.mjs");
let dir, ENV;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "linkmcp-"));
  ENV = {
    ACCESS_TOKEN: "secret-token",
    LINK_REFRESH_TOKEN: "liwlrt_must_not_reach_cli",
    LINK_CLI_BIN: FAKE,
    LINK_AUTH_FILE: path.join(dir, "auth.json"),
    PATH: process.env.PATH,
  };
});

// Settings for the fake link-cli (see test/fake-link-cli.mjs).
function env(fake = {}) {
  fs.writeFileSync(path.join(dir, "fake.json"), JSON.stringify(fake));
  return ENV;
}

async function rpc(e, method, params, token = "secret-token") {
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await worker.fetch(req, e);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
const call = async (e, name, args = {}) => (await rpc(e, "tools/call", { name, arguments: args })).body.result;
const textOf = (r) => r.content[0].text;
const log = () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const calls = () => log().filter((l) => l.at === "start");

test("rejects a wrong or missing token", async () => {
  assert.equal((await rpc(env(), "ping", {}, "nope")).status, 401);
  const res = await worker.fetch(new Request("https://w.example/mcp", { method: "POST", body: "{}" }), env());
  assert.equal(res.status, 401);
  assert.equal((await worker.fetch(new Request("https://w.example/other"), env())).status, 404);
});

test("initialize and tools/list", async () => {
  const init = await rpc(env(), "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.match(init.body.result.instructions, /integer cents/);
  const list = await rpc(env(), "tools/list", {});
  const names = list.body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["auth_status", "sign_in", "list_sources", "list_balances", "list_transactions", "list_insight_types", "list_insights"]);
  assert.equal(list.body.result.tools.find((t) => t.name === "list_balances").annotations.readOnlyHint, true);
});

test("not signed in: tools explain how to sign in", async () => {
  const r = await call(env(), "list_sources");
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Not signed in to Link\. Call sign_in/);
  const s = JSON.parse(textOf(await call(env(), "auth_status")));
  assert.equal(s.authenticated, false);
  assert.equal(s.credentials_path, undefined);
});

test("sign-in flow is read-only and never leaks tokens", async () => {
  const r = JSON.parse(textOf(await call(env(), "sign_in")));
  assert.equal(r.verification_url, "https://link.com/device?c=1");
  assert.equal(r.phrase, "apple banana");
  assert.equal(r.instruction, undefined);
  const login = calls().find((c) => c.args[1] === "login");
  assert.deepEqual(login.args, [
    "auth", "login", "--client-name", "Claude (read-only)", "--no-agentic-payments",
    "--source-actions", "read_balances", "--source-actions", "read_external_transactions",
    "--source-actions", "read_source_details", "--format", "json",
  ]);
  assert.equal(login.env.NO_UPDATE_NOTIFIER, "1");
  assert.equal(login.env.ACCESS_TOKEN, undefined);
  assert.equal(login.env.LINK_REFRESH_TOKEN, undefined);

  const pending = JSON.parse(textOf(await call(env(), "auth_status")));
  assert.equal(pending.pending, true);

  const done = textOf(await call(env({ approve: true }), "auth_status", { wait_seconds: 10 }));
  assert.doesNotMatch(done, /liwl/);
  const s = JSON.parse(done);
  assert.equal(s.authenticated, true);
  assert.equal(s.access_token, undefined);
  assert.equal(s.update, undefined);
  assert.ok(calls().some((c) => c.args.join(" ").includes("auth status --interval 5 --timeout 10")));

  const again = JSON.parse(textOf(await call(env(), "sign_in")));
  assert.match(again.note, /Already signed in/);

  const upgraded = JSON.parse(textOf(await call(env(), "sign_in", { mode: "add_access", source_actions: ["read_link_transactions"] })));
  assert.equal(upgraded.phrase, "cherry date");
  const up = calls().find((c) => c.args[1] === "upgrade");
  assert.ok(!up.args.includes("--scope"));
  assert.ok(up.args.includes("read_link_transactions"));

  const bad = await call(env(), "sign_in", { source_actions: ["payment_methods.agentic"] });
  assert.equal(bad.isError, true);
});

test("replace_existing logs out first", async () => {
  await call(env(), "sign_in");
  await call(env({ approve: true }), "auth_status");
  const r = JSON.parse(textOf(await call(env(), "sign_in", { replace_existing: true })));
  assert.equal(r.phrase, "apple banana");
  const seq = calls().map((c) => c.args.slice(0, 2).join(" "));
  assert.deepEqual(seq.slice(-2), ["auth logout", "auth login"]);
});

async function signedIn() {
  await call(env(), "sign_in");
  await call(env({ approve: true }), "auth_status");
}

test("sources, balances", async () => {
  await signedIn();
  const s = JSON.parse(textOf(await call(env(), "list_sources")));
  assert.equal(s.data[0].id, "csmrpd_bank");
  const b = JSON.parse(textOf(await call(env(), "list_balances", { source_ids: ["csmrpd_bank"] })));
  assert.equal(b.data[0].source, "csmrpd_bank");
  const bad = await call(env(), "list_balances", { source_ids: ["--format"] });
  assert.equal(bad.isError, true);
});

test("transactions: follows pages, honours max_results, redacts", async () => {
  await signedIn();
  const all = textOf(await call(env(), "list_transactions", { source_ids: ["csmrpd_bank"], start_date: "2026-10-01" }));
  assert.doesNotMatch(all, /liwl/);
  const r = JSON.parse(all);
  assert.equal(r.count, 250);
  assert.equal(r.pages, 3);
  assert.equal(r.has_more, false);
  const t = calls().filter((c) => c.args[0] === "transactions");
  assert.deepEqual(t[1].args.slice(-6), ["--limit", "100", "--starting-after", "txn_099", "--format", "json"]);

  const capped = JSON.parse(textOf(await call(env(), "list_transactions", { max_results: 150 })));
  assert.equal(capped.count, 150);
  assert.equal(capped.has_more, true);
  assert.equal(capped.next_starting_after, "txn_149");

  const one = JSON.parse(textOf(await call(env(), "list_transactions", { all_pages: false, limit: 5 })));
  assert.equal(one.data.length, 5);
  assert.equal(one.has_more, true);

  assert.equal((await call(env(), "list_transactions", { start_date: "11/01/2026" })).isError, true);
});

test("expired session and crashes are reported without tokens", async () => {
  await signedIn();
  const r = await call(env({ mode: "redeemed" }), "list_sources");
  assert.equal(r.isError, true);
  assert.match(textOf(r), /replace_existing: true/);
  const c = await call(env({ mode: "crash" }), "list_sources");
  assert.equal(c.isError, true);
  assert.match(textOf(c), /exit 2/);
  assert.doesNotMatch(textOf(c), /liwl/);
});

test("only allowed commands run, and calls are serialized", async () => {
  assert.throws(() => runLinkCli(env(), ["spend-request", "create"]), /not allowed/);
  assert.throws(() => runLinkCli(env(), ["payment-methods", "list"]), /not allowed/);
  await signedIn();
  const before = log().length;
  const results = await Promise.all(Array.from({ length: 5 }, () => runLinkCli(env(), ["sources", "list"])));
  assert.equal(results.length, 5);
  const ats = log().slice(before).map((l) => l.at);
  assert.deepEqual(ats, Array(5).fill(["start", "end"]).flat());
});

test("redact", () => {
  assert.deepEqual(redact({ access_token: "x", a: ["liwlrt_abc.def ok"], refresh_token: "y" }), { a: ["[redacted] ok"] });
});
