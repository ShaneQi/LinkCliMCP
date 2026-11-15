// MCP tools. All of them are read-only with respect to money: they list
// sources, balances, transactions and insights, and manage the read-only
// Link sign-in that this server holds.
import { UserError } from "./errors.js";
import { runLinkCli, READ_SOURCE_ACTIONS } from "./linkcli.js";

const DEFAULT_SOURCE_ACTIONS = ["read_balances", "read_external_transactions", "read_source_details"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_]+$/;

function date(name, v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new UserError(`${name} must be a date like 2026-11-01.`);
  }
  return v;
}
function id(name, v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !ID_RE.test(v)) throw new UserError(`${name} must be an id like csmrpd_… (letters, digits, _).`);
  return v;
}
function ids(name, v) {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => id(name, x));
}
function int(name, v, min, max) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
function text(name, v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 100 || v.startsWith("-") || /[\0\n\r]/.test(v)) throw new UserError(`${name} is not valid.`);
  return v;
}

function push(args, flag, value) {
  if (value === undefined) return;
  for (const v of Array.isArray(value) ? value : [value]) args.push(flag, String(v));
}

const out = (obj) => JSON.stringify(obj, null, 1);

// link-cli list output is { data: [...], has_more } (or a bare array); find the items.
function listItems(res) {
  if (Array.isArray(res)) return { items: res, hasMore: false };
  if (res && Array.isArray(res.data)) return { items: res.data, hasMore: !!res.has_more };
  return { items: null, hasMore: false };
}

// `auth status` / `auth login` stream results; with --format json they arrive as an array.
const last = (res) => (Array.isArray(res) ? res[res.length - 1] : res) ?? {};

function cleanStatus(s) {
  const { credentials_path, update, token_type, _next, instruction, ...rest } = s;
  return rest;
}

const SOURCE_ACTIONS_SCHEMA = {
  type: "array",
  items: { type: "string", enum: READ_SOURCE_ACTIONS },
  description: `Read access to request. Default: ${DEFAULT_SOURCE_ACTIONS.join(", ")}.`,
};

export const TOOLS = [
  {
    name: "auth_status",
    title: "Link sign-in status",
    description:
      "Shows whether this server is signed in to Link, which access was granted, and any sign-in link " +
      "still waiting for approval. Also finishes a pending sign-in once the user has approved it. " +
      "Set wait_seconds to keep checking until the user approves.",
    inputSchema: {
      type: "object",
      properties: {
        wait_seconds: { type: "integer", minimum: 0, maximum: 120, description: "Keep polling up to this long (default 0: check once)." },
      },
      additionalProperties: false,
    },
    async run(env, a) {
      const wait = int("wait_seconds", a.wait_seconds, 0, 120) ?? 0;
      const args = ["auth", "status"];
      if (wait > 0) args.push("--interval", "5", "--timeout", String(wait));
      const s = cleanStatus(last(await runLinkCli(env, args)));
      if (!s.authenticated && s.pending) {
        s.note = "Waiting for the user to approve the sign-in link in the Link app.";
      } else if (!s.authenticated) {
        s.note = "Not signed in. Call sign_in.";
      }
      return out(s);
    },
  },
  {
    name: "sign_in",
    title: "Start a read-only Link sign-in",
    description:
      "Starts a read-only Link device sign-in (no payment access is ever requested) and returns a " +
      "verification_url and phrase. Give both to the user and ask them to select every account the task " +
      "needs (access is per account), then call auth_status with wait_seconds to finish. " +
      "mode \"new\" starts a session (replace_existing: true signs out the current one first); " +
      "mode \"add_access\" keeps the current session and asks for additional accounts or actions.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["new", "add_access"], description: "Default new." },
        source_actions: SOURCE_ACTIONS_SCHEMA,
        replace_existing: { type: "boolean", description: "mode new only: sign out the current session first." },
        client_name: { type: "string", description: "Name shown in the Link app. Default: LINK_CLIENT_NAME or \"Claude (read-only)\"." },
      },
      additionalProperties: false,
    },
    destructive: true,
    async run(env, a) {
      const mode = a.mode ?? "new";
      if (!["new", "add_access"].includes(mode)) throw new UserError("mode must be new or add_access.");
      const actions = a.source_actions?.length ? a.source_actions : DEFAULT_SOURCE_ACTIONS;
      for (const x of actions) {
        if (!READ_SOURCE_ACTIONS.includes(x)) throw new UserError(`Unknown source action: ${x}`);
      }
      const name = text("client_name", a.client_name) ?? env.LINK_CLIENT_NAME ?? "Claude (read-only)";

      const args = mode === "new"
        ? ["auth", "login", "--client-name", name, "--no-agentic-payments"]
        : ["auth", "upgrade", "--client-name", name];
      push(args, "--source-actions", [...new Set(actions)]);

      if (mode === "new" && a.replace_existing) await runLinkCli(env, ["auth", "logout"]);
      const r = cleanStatus(last(await runLinkCli(env, args)));
      if (r.authenticated && !r.verification_url) {
        return out({
          ...r,
          note: "Already signed in; nothing changed. Use mode add_access to add accounts, or replace_existing: true to start over.",
        });
      }
      return out({
        ...r,
        next: "Give the user the verification_url and phrase, ask them to approve in the Link app and select every account needed, then call auth_status with wait_seconds: 60 (repeat if still pending).",
      });
    },
  },
  {
    name: "list_sources",
    title: "List Link sources",
    description:
      "Lists the accounts this sign-in can read: id (csmrpd_…), type (bank_account or card), last4, " +
      "institution and granted_actions. Use the ids with list_balances and list_transactions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        starting_after: { type: "string", description: "Cursor: a source id from the previous page." },
      },
      additionalProperties: false,
    },
    async run(env, a) {
      const args = ["sources", "list"];
      push(args, "--limit", int("limit", a.limit, 1, 100));
      push(args, "--starting-after", id("starting_after", a.starting_after));
      return out(await runLinkCli(env, args));
    },
  },
  {
    name: "list_balances",
    title: "List balances",
    description:
      "Current balances, in integer cents. Bank: cash.available.usd. Card: credit.used.usd is the total " +
      "owed including pending (negative), credit.current is posted only.",
    inputSchema: {
      type: "object",
      properties: {
        source_ids: { type: "array", items: { type: "string" }, description: "Only these sources (csmrpd_…)." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        starting_after: { type: "string" },
      },
      additionalProperties: false,
    },
    async run(env, a) {
      const args = ["balances", "list"];
      push(args, "--source", ids("source_ids", a.source_ids));
      push(args, "--limit", int("limit", a.limit, 1, 100));
      push(args, "--starting-after", id("starting_after", a.starting_after));
      return out(await runLinkCli(env, args));
    },
  },
  {
    name: "list_transactions",
    title: "List transactions",
    description:
      "Transactions from connected bank and card accounts: created_date, description, category, amount " +
      "(integer cents), status (succeeded or pending). Bank: negative = money out. Card: negative = charge, " +
      "positive = payment or refund. created_date can be 1–2 days off the bank's date; amounts match exactly. " +
      "By default follows pages until max_results; set all_pages: false for one page.",
    inputSchema: {
      type: "object",
      properties: {
        source_ids: { type: "array", items: { type: "string" }, description: "Only these sources (csmrpd_…)." },
        start_date: { type: "string", description: "YYYY-MM-DD, inclusive." },
        end_date: { type: "string", description: "YYYY-MM-DD, inclusive." },
        category: { type: "string" },
        origin: { type: "string", enum: ["link", "external_connection"] },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 100)." },
        starting_after: { type: "string", description: "Cursor: a transaction id." },
        ending_before: { type: "string", description: "Cursor: a transaction id." },
        all_pages: { type: "boolean", description: "Follow has_more (default true)." },
        max_results: { type: "integer", minimum: 1, maximum: 5000, description: "Stop after this many (default 1000)." },
      },
      additionalProperties: false,
    },
    async run(env, a) {
      const base = ["transactions", "list"];
      push(base, "--source", ids("source_ids", a.source_ids));
      push(base, "--start-date", date("start_date", a.start_date));
      push(base, "--end-date", date("end_date", a.end_date));
      push(base, "--category", text("category", a.category));
      if (a.origin !== undefined) {
        if (!["link", "external_connection"].includes(a.origin)) throw new UserError("origin must be link or external_connection.");
        push(base, "--origin", a.origin);
      }
      const limit = int("limit", a.limit, 1, 100) ?? 100;
      const max = int("max_results", a.max_results, 1, 5000) ?? 1000;
      const ending = id("ending_before", a.ending_before);
      let cursor = id("starting_after", a.starting_after);
      const all = a.all_pages !== false && !ending;

      const page = async () => {
        const args = [...base];
        push(args, "--limit", limit);
        push(args, "--starting-after", cursor);
        push(args, "--ending-before", ending);
        return runLinkCli(env, args);
      };

      const first = await page();
      const { items, hasMore } = listItems(first);
      if (!all || items === null) return out(first);

      const data = [...items];
      let more = hasMore;
      let pages = 1;
      while (more && data.length < max && data.length) {
        cursor = data[data.length - 1].id;
        if (!cursor) break;
        const next = listItems(await page());
        if (next.items === null) break;
        data.push(...next.items);
        more = next.hasMore;
        pages++;
      }
      const truncated = data.length > max;
      const kept = data.slice(0, max);
      return out({
        count: kept.length,
        pages,
        has_more: more || truncated,
        ...((more || truncated) && kept.length ? { next_starting_after: kept[kept.length - 1].id } : {}),
        data: kept,
      });
    },
  },
  {
    name: "list_insight_types",
    title: "List insight types",
    description: "Lists the financial insight ids Link offers, what each is and the access it needs.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, starting_after: { type: "string" } },
      additionalProperties: false,
    },
    async run(env, a) {
      const args = ["insights", "list-available-types"];
      push(args, "--limit", int("limit", a.limit, 1, 100));
      push(args, "--starting-after", id("starting_after", a.starting_after));
      return out(await runLinkCli(env, args));
    },
  },
  {
    name: "list_insights",
    title: "List insights",
    description: "Returns Link's precomputed financial insights (e.g. spending patterns, preferred businesses).",
    inputSchema: {
      type: "object",
      properties: {
        insight_ids: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        starting_after: { type: "string" },
      },
      additionalProperties: false,
    },
    async run(env, a) {
      const args = ["insights", "list"];
      push(args, "--insight", ids("insight_ids", a.insight_ids));
      push(args, "--limit", int("limit", a.limit, 1, 100));
      push(args, "--starting-after", id("starting_after", a.starting_after));
      return out(await runLinkCli(env, args));
    },
  },
];
