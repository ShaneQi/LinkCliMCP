// HTTP handler (fetch-style Request -> Response): checks the connector token,
// then serves MCP at POST /mcp. src/server.js runs it as a Node HTTP server.
import { timingSafeEqual, createHash } from "node:crypto";
import { handleMcp } from "./mcp.js";

function tokenMatches(request, env) {
  const given = request.headers.get("Authorization") ?? "";
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(`Bearer ${env.ACCESS_TOKEN}`));
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("Link CLI MCP connector (read-only). Use /mcp.\n");
    if (pathname !== "/mcp") return new Response("Not found\n", { status: 404 });
    if (!env.ACCESS_TOKEN) return new Response("Server is missing its ACCESS_TOKEN secret.\n", { status: 500 });
    if (!tokenMatches(request, env)) {
      return new Response("Unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    return handleMcp(request, env);
  },
};
