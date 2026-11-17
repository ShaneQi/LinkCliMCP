#!/usr/bin/env node
// Stand-in for link-cli in tests. Next to the --auth file it reads fake.json
// (test settings: mode, approve), appends each call (argv + selected env) to
// log.jsonl, and keeps its sign-in state in the auth file itself.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--auth");
const auth = argv[i + 1];
const args = argv.filter((_, k) => k !== i && k !== i + 1);
const dir = path.dirname(auth);
const cfg = fs.existsSync(path.join(dir, "fake.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "fake.json"), "utf8")) : {};
const log = (o) => fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(o) + "\n");
log({ args, at: "start", env: { LINK_REFRESH_TOKEN: process.env.LINK_REFRESH_TOKEN, CF_ACCESS_AUD: process.env.CF_ACCESS_AUD, NO_UPDATE_NOTIFIER: process.env.NO_UPDATE_NOTIFIER } });
process.on("exit", () => log({ args, at: "end" }));

const state = fs.existsSync(auth) ? JSON.parse(fs.readFileSync(auth, "utf8")) : {};
const save = () => fs.writeFileSync(auth, JSON.stringify(state));
const print = (v, code = 0) => { process.stdout.write(JSON.stringify(v, null, 2)); process.exit(code); };
const cmd = args.slice(0, 2).join(" ");
const opt = (name) => { const k = args.indexOf(name); return k === -1 ? undefined : args[k + 1]; };

if (cfg.mode === "crash") { process.stderr.write("boom liwlrt_secret123\n"); process.exit(2); }
if (cfg.mode === "redeemed" && cmd !== "auth status") {
  print({ code: "API_ERROR", message: "Token refresh failed (400): refresh_token is not active: status: redeemed" }, 1);
}

switch (cmd) {
  case "auth status":
    if (state.pending && cfg.approve) { state.tokens = { access_token: "liwlat_abcdefghijklmnopqrstuvwxyz", refresh_token: "liwlrt_zzz" }; delete state.pending; save(); }
    if (state.tokens) print([{ authenticated: true, access_token: "liwlat_abcdefghijklm...", token_type: "Bearer", credentials_path: auth, scope: "userinfo:read", authorization_details: [{ type: "link_source", actions: ["read_balances"] }], update: { latest_version: "9" } }]);
    print([{ authenticated: false, credentials_path: auth, ...(state.pending ? { pending: true, verification_url: "https://link.com/device?c=1", phrase: "apple banana" } : {}) }]);
  case "auth login":
    if (state.tokens) print([{ authenticated: true, message: "You are already logged in." }]);
    state.pending = true; save();
    print([{ verification_url: "https://link.com/device?c=1", phrase: "apple banana", instruction: "x", _next: {} }]);
  case "auth upgrade":
    state.pending = true; save();
    print([{ verification_url: "https://link.com/device?c=2", phrase: "cherry date" }]);
  case "auth logout":
    delete state.tokens; delete state.pending; save();
    print([{ authenticated: false }]);
  default:
    if (!state.tokens) print({ code: "NOT_AUTHENTICATED", message: "Not authenticated. Run \"link-cli auth login\" first." }, 1);
}

switch (cmd) {
  case "sources list":
    print({ data: [{ id: "csmrpd_bank", type: "bank_account", last4: "2308" }, { id: "csmrpd_card", type: "card", last4: "6741" }], has_more: false });
  case "balances list":
    print({ data: [{ source: opt("--source") ?? "all", cash: { available: { usd: 12345 } } }], has_more: false });
  case "transactions list": {
    const all = Array.from({ length: 250 }, (_, n) => ({ id: `txn_${String(n).padStart(3, "0")}`, amount: -100 * n, description: n === 0 ? "token liwlat_leaked" : "Coffee" }));
    const after = opt("--starting-after");
    const start = after ? all.findIndex((t) => t.id === after) + 1 : 0;
    const limit = Number(opt("--limit") ?? 10);
    const data = all.slice(start, start + limit);
    print({ data, has_more: start + limit < all.length });
  }
  case "insights list":
  case "insights list-available-types":
    print({ data: [], has_more: false });
}
print({ code: "UNKNOWN", message: `fake: ${cmd}` }, 1);
