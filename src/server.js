// Node entry point: runs the connector as a plain-HTTP server (e.g. in a
// container behind an HTTPS reverse proxy). Routes:
//   POST /mcp     (Authorization: Bearer <ACCESS_TOKEN>)
//   GET  /health  (also /healthz; Cloud Run reserves paths ending in "z")
//
// Configuration (environment variables):
//   ACCESS_TOKEN        required: bearer token Claude sends (exits if unset)
//   LINK_AUTH_FILE      link-cli sign-in file (default /data/link-auth.json).
//                       Keep it on a persistent volume: the refresh token in it
//                       rotates on every refresh and the old one stops working.
//   LINK_CLIENT_NAME    name shown in the Link app at sign-in (default "Claude (read-only)")
//   KEEPALIVE_MINUTES   make one cheap read this often so the session keeps
//                       refreshing while idle (default 0 = off)
//   PORT                default 8787
//
// Run exactly one instance per auth file: two processes refreshing the same
// token chain break it.
import http from "node:http";
import app from "./index.js";
import { runLinkCli, authFile, idle } from "./linkcli.js";

const PORT = Number(process.env.PORT || 8787);
const KEEPALIVE_MINUTES = Number(process.env.KEEPALIVE_MINUTES ?? 0);

// Tokens must never reach the CLI through env; drop them from what handlers see.
const { LINK_ACCESS_TOKEN, LINK_REFRESH_TOKEN, ...env } = process.env;
if (LINK_ACCESS_TOKEN || LINK_REFRESH_TOKEN) {
  console.warn("warning: LINK_ACCESS_TOKEN / LINK_REFRESH_TOKEN are ignored; sign in with the sign_in tool instead");
}
if (!env.ACCESS_TOKEN?.trim()) {
  console.error("error: ACCESS_TOKEN is not set. Set it to a long random string (openssl rand -base64 32); Claude sends it as Authorization: Bearer <token>.");
  process.exit(1);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      return;
    }
    const host = req.headers.host ?? `localhost:${PORT}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(new URL(req.url, `http://${host}`), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: hasBody ? await readBody(req) : undefined,
    });
    const response = await app.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) res.writeHead(e.status || 500, { "Content-Type": "text/plain" });
    res.end(e.status ? `${e.message}\n` : "Internal error\n");
  }
});

async function keepalive() {
  try {
    const s = await runLinkCli(env, ["auth", "status"]);
    const status = Array.isArray(s) ? s[s.length - 1] : s;
    if (!status?.authenticated) return console.log("keepalive: not signed in");
    await runLinkCli(env, ["sources", "list", "--limit", "1"]);
    console.log("keepalive: ok");
  } catch (e) {
    console.error(`keepalive failed: ${e?.message ?? e}`);
  }
}

server.listen(PORT, () => {
  console.log(`Link CLI MCP listening on :${PORT} (auth file: ${authFile(env)})`);
  if (KEEPALIVE_MINUTES > 0) setInterval(keepalive, KEEPALIVE_MINUTES * 60_000).unref();
});

const shutdown = () => {
  console.log("shutting down");
  server.close();
  idle().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 70_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
