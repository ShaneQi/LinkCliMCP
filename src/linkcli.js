// Runs Stripe's link-cli as a child process, read-only.
//
// - Only the commands in ALLOWED can run; anything that spends money,
//   touches payment methods or reports purchases is not reachable from here.
// - Every call goes through one queue. link-cli refresh tokens rotate and are
//   single-use, so two overlapping refreshes would kill the session.
// - The sign-in is kept at LINK_AUTH_FILE (default /data/link-auth.json), but
//   link-cli never writes there itself: it saves by writing a temp file and
//   renaming it over the target, which a Cloud Storage (gcsfuse) mount refuses
//   (EACCES). link-cli works on a copy in a local directory instead, and this
//   module syncs it: before each call the persistent file is read (it is the
//   source of truth, so a change made elsewhere wins); after each call, if
//   link-cli changed the copy, the persistent file is overwritten in place.
// - LINK_ACCESS_TOKEN / LINK_REFRESH_TOKEN are never handed to the child
//   (link-cli does not save refreshed env tokens back).
// - Output is parsed as JSON and scrubbed of tokens before anyone sees it.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { UserError } from "./errors.js";

const require = createRequire(import.meta.url);

// "<command> <subcommand>" pairs this server may run.
export const ALLOWED = new Set([
  "auth status",
  "auth login",
  "auth upgrade",
  "auth logout",
  "sources list",
  "balances list",
  "transactions list",
  "insights list",
  "insights list-available-types",
]);

export const READ_SOURCE_ACTIONS = [
  "read_balances",
  "read_external_transactions",
  "read_link_transactions",
  "read_source_details",
];

export function cliPath(env) {
  if (env.LINK_CLI_BIN) return env.LINK_CLI_BIN;
  const pkg = require.resolve("@stripe/link-cli/package.json");
  return path.join(path.dirname(pkg), "dist", "cli.js");
}

export function authFile(env) {
  return env.LINK_AUTH_FILE || "/data/link-auth.json";
}

// Local directory holding link-cli's working copy of the auth file.
export function workDir(env) {
  return env.LINK_WORK_DIR || path.join(os.tmpdir(), "link-cli-mcp");
}

const readOrNull = async (f) => {
  try {
    return await fs.readFile(f, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

// What the persistent file and the working copy last agreed on.
let synced;

// Persistent file -> working copy, when the persistent file changed (or on first use).
async function pull(persistent, working) {
  const stored = await readOrNull(persistent);
  if (synced !== undefined && stored === synced) return;
  await fs.mkdir(path.dirname(working), { recursive: true, mode: 0o700 });
  if (stored === null) await fs.rm(working, { force: true });
  else await fs.writeFile(working, stored, { mode: 0o600 });
  synced = stored;
}

// Working copy -> persistent file, when link-cli changed it. Written in place
// (no temp file, no rename); a Cloud Storage object is replaced whole on close.
async function push(persistent, working) {
  const current = await readOrNull(working);
  if (current === synced) return;
  if (current === null) await fs.rm(persistent, { force: true });
  else {
    await fs.mkdir(path.dirname(persistent), { recursive: true, mode: 0o700 });
    await fs.writeFile(persistent, current, { mode: 0o600 });
  }
  synced = current;
}

// Removes temp files left next to the persistent file by link-cli versions of
// this server that let it write there directly (a failed rename leaves them).
export async function cleanStaleTempFiles(env) {
  const file = authFile(env);
  const prefix = `${path.basename(file)}.tmp-`;
  let names = [];
  try {
    names = await fs.readdir(path.dirname(file));
  } catch {
    return 0;
  }
  const stale = names.filter((n) => n.startsWith(prefix));
  await Promise.allSettled(stale.map((n) => fs.rm(path.join(path.dirname(file), n), { force: true })));
  return stale.length;
}

// Environment for the child: only what it needs. No connector secret, no env tokens.
function childEnv(env) {
  const out = { NO_UPDATE_NOTIFIER: "1", LINK_CLI_SKIP_SKILL_INSTALL: "1", CI: "1" };
  for (const k of ["PATH", "HOME", "TZ", "LANG", "NODE_EXTRA_CA_CERTS", "LINK_HTTP_PROXY",
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
    "NODE_USE_ENV_PROXY", "LINK_API_BASE_URL", "LINK_AUTH_BASE_URL"]) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return out;
}

const TOKEN_RE = /liwl[a-z]*_[A-Za-z0-9._\-]+/g;
const SECRET_KEYS = new Set(["access_token", "refresh_token", "id_token", "device_code"]);

// Removes token fields and anything shaped like a Link token.
export function redact(value) {
  if (typeof value === "string") return value.replace(TOKEN_RE, "[redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Resolves once every queued link-cli call has finished (used on shutdown, so a
// refresh that already redeemed the old token gets to save the new one).
export const idle = () => queue;

function exec(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, error, stdout, stderr });
    });
  });
}

/**
 * Runs `link-cli <args> --format json` and returns the parsed, redacted output.
 * Throws UserError with link-cli's own message when it reports an error.
 */
export function runLinkCli(env, args) {
  const key = args.slice(0, 2).join(" ");
  if (!ALLOWED.has(key)) throw new Error(`link-cli command not allowed: ${key}`);
  const persistent = authFile(env);
  const working = path.join(workDir(env), path.basename(persistent));
  const bin = cliPath(env);
  const timeout = Number(env.LINK_CLI_TIMEOUT_SECONDS || 60) * 1000;

  return serialize(async () => {
    try {
      await pull(persistent, working);
    } catch (e) {
      throw new UserError(`Could not read the saved sign-in at ${persistent}: ${e.message}`);
    }
    let r;
    try {
      const argv = [bin, "--auth", working, ...args, "--format", "json"];
      r = await exec(process.execPath, argv, {
        env: childEnv(env),
        cwd: path.dirname(working),
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
    } finally {
      // Save even when the command failed: a refresh may already have rotated the token.
      try {
        await push(persistent, working);
      } catch (e) {
        console.error(`could not save the sign-in to ${persistent}: ${e.message}`);
        throw new UserError(
          `link-cli ran, but the sign-in could not be saved to ${persistent} (${e.message}). ` +
          "This instance keeps working, but after a restart it will be signed out. Check that the volume is writable.",
        );
      }
    }
    if (r.error?.killed) throw new UserError(`link-cli timed out after ${timeout / 1000} s (${key}).`);

    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      const detail = String(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-3).join(" ");
      throw new UserError(`link-cli ${key} failed (exit ${r.code}): ${redact(detail) || "no output"}`);
    }
    parsed = redact(parsed);
    if (r.code !== 0) {
      throw new UserError(describeError(parsed, key));
    }
    return parsed;
  });
}

// For tests: forget what was last synced (as a fresh process would).
export function resetSync() {
  synced = undefined;
}

function describeError(p, key) {
  if (!p || typeof p !== "object") return `link-cli ${key} failed.`;
  const msg = p.message || JSON.stringify(p);
  if (p.code === "NOT_AUTHENTICATED") {
    return `Not signed in to Link. Call sign_in, give the user the link, then call auth_status. (${msg})`;
  }
  if (/refresh|redeemed|invalid_grant|not active/i.test(msg)) {
    return `The Link session has expired or its refresh token was already used: ${msg} ` +
      "Call sign_in (with replace_existing: true) and have the user approve the new link.";
  }
  return `${p.code ? `${p.code}: ` : ""}${msg}`;
}
