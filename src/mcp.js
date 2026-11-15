// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
import { UserError } from "./errors.js";
import { TOOLS } from "./tools.js";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS =
  "Read-only access to the user's bank and card accounts connected to Stripe Link, through link-cli. " +
  "No tool can spend money or change payment methods. Amounts are integer cents. " +
  "Start with list_sources to get account ids. Bank balance: cash.available.usd. Card balance: " +
  "credit.used.usd = total owed including pending (negative); current = posted only. " +
  "Transactions: on a bank account negative = money out; on a card negative = charge, positive = payment/refund " +
  "(identify card payments by \"Payment Thank You\" or a positive amount, not by keywords). created_date can be " +
  "1–2 days off the bank's date; reconcile by amount. If a tool says the server is not signed in or the session " +
  "expired, call sign_in, give the user the verification_url and phrase, then call auth_status with wait_seconds.";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcp(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(fail(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body : [body]) {
    const reply = await handleMessage(msg, env);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && typeof msg === "object" && "id" in msg ? fail(msg.id ?? null, -32600, "Invalid request") : null;
  }
  if (!("id" in msg)) return null; // notification

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "link-cli", title: "Link (read-only)", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, destructive }) => ({
          name, title, description, inputSchema,
          annotations: destructive
            ? { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
            : { title, readOnlyHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      return ok(msg.id, await callTool(tool, msg.params.arguments ?? {}, env));
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(tool, args, env) {
  const t = Date.now();
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new UserError("arguments must be an object.");
    const out = await tool.run(env, args);
    console.log(`tool ${tool.name}: ok (${Date.now() - t} ms)`);
    return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
  } catch (e) {
    const user = e instanceof UserError;
    console.log(`tool ${tool.name}: ${user ? "error" : "failed"} (${Date.now() - t} ms)`);
    if (!user) console.error(e);
    const text = user ? e.message : `Unexpected error: ${e?.message ?? e}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}
