# Link CLI MCP connector

A remote [MCP](https://modelcontextprotocol.io) server that hosts Stripe's
[link-cli](https://github.com/stripe/link-cli) and gives Claude **read-only**
access to the bank and card accounts connected to your Link wallet: sources,
balances, transactions and insights. It runs as a small container on any VPS
or on Cloud Run, so it works from claude.ai on the web, desktop and mobile,
Claude Code, Cowork and scheduled runs, without installing link-cli or
juggling refresh tokens in each session.

Access is controlled by [Cloudflare Access](#authentication-cloudflare-access):
the server only answers MCP requests that carry a valid Access JWT. The Link
sign-in stays on the server.

- **Tools:** `list_sources`, `list_balances`, `list_transactions` (follows
  pages for you), `list_insight_types`, `list_insights`, plus `auth_status`,
  `sign_in` and `sign_out` for the server's own Link sign-in.
- **Read-only by construction:** the server can only run `auth`, `sources
  list`, `balances list`, `transactions list` and `insights list*`.
  `spend-request`, `mpp`, `ucp`, `payment-methods`, `shipping-address`,
  `report`, `onboard` and `demo` are not reachable, and sign-in always passes
  `--no-agentic-payments` and only read source actions.
- **No token leaks:** `access_token` / `refresh_token` fields and anything
  shaped like a Link token (`liwl…_…`) are stripped from every result and
  error.

## How it works

1. Each tool call runs the pinned `link-cli` (`@stripe/link-cli@1.3.0`) as a
   child process with `--auth $LINK_AUTH_FILE --format json`, and parses its
   JSON.
2. All link-cli calls go through **one queue**. Link refresh tokens rotate and
   are single-use: each refresh returns a new pair and the old refresh token
   is dead (`refresh_token is not active: status: redeemed`). Running calls
   one at a time and letting link-cli save the new pair to its auth file
   keeps the chain intact.
3. The auth file lives on a persistent volume (`/data/link-auth.json`), so the
   session survives restarts and redeploys. `LINK_ACCESS_TOKEN` /
   `LINK_REFRESH_TOKEN` are deliberately ignored: link-cli does not save
   refreshed env tokens back, so they would die after the first hour.

### Signing in

Done once, from any Claude client connected to the server:

1. Ask Claude to sign in (it calls `sign_in`). It returns a
   `verification_url` and a phrase.
2. Open the link, check the phrase, and approve in the Link app. **Select
   every account you want Claude to read** (e.g. checking …2308, cards …6741,
   …0915): access is per account.
3. Claude calls `auth_status` (with `wait_seconds`) until it reports
   `authenticated: true`.

Default access: `read_balances`, `read_external_transactions`,
`read_source_details` (`read_link_transactions` can be requested too). To add
accounts later, `sign_in` with `mode: "add_access"` keeps the current session
and merges in the new approval. `replace_existing: true` signs out and starts
over (use it when the session has expired).

### Signing out

Ask Claude to sign out of Link (it calls `sign_out`). The server runs
`link-cli auth logout`, which revokes the refresh token with Link and clears
`/data/link-auth.json`, including any pending sign-in link. Every client using
the connector loses access until someone signs in again. Without Claude:

    docker exec link-cli-mcp node /app/node_modules/@stripe/link-cli/dist/cli.js \
      --auth /data/link-auth.json auth logout

Deleting the file also signs the server out, but leaves the token valid on
Link's side until it expires.

## Running it on a VPS

You need Docker on a Linux server (amd64 or arm64) and an HTTPS reverse proxy
(Caddy, nginx, Traefik, a tunnel, …). The container speaks plain HTTP on port
8787.

### 1. Get the image

Every push to `main` publishes `ghcr.io/shaneqi/linkclimcp:latest` (also
`:sha-<commit>`, and the version on `v*` tags). GitHub makes new packages
private: either make it public (GitHub → profile → Packages → linkclimcp →
Package settings → Change visibility), or log in on the server with a token
that has `read:packages`:

    echo <token> | docker login ghcr.io -u <github-user> --password-stdin

Or build it yourself: `docker build -t link-cli-mcp .`

### 2. Configure

Create `.env` next to your compose file and `chmod 600 .env`:

    # Required (see "Authentication (Cloudflare Access)")
    CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
    CF_ACCESS_AUD=<Application Audience (AUD) Tag>

    # Optional
    # LINK_CLIENT_NAME=Claude (read-only)   (name shown in the Link app at sign-in)
    # KEEPALIVE_MINUTES=0                   (cheap read every N minutes; 0 = off)

The server exits at startup if either `CF_ACCESS_*` variable is missing.

### 3. Start

    cp compose.example.yml compose.yml
    docker compose up -d
    docker logs -f link-cli-mcp        # expect: "Link CLI MCP listening on :8787"

`compose.example.yml` binds `127.0.0.1:8787` (reachable only through your
proxy) and keeps the sign-in in the `link-auth` volume at `/data`. Without
compose:

    docker run -d --name link-cli-mcp --restart unless-stopped \
      --env-file .env -p 127.0.0.1:8787:8787 -v link-auth:/data \
      ghcr.io/shaneqi/linkclimcp:latest

**Run one container per volume.** Two processes refreshing the same token
chain break the sign-in.

### 4. Put it behind Cloudflare Access

The hostname must go through Cloudflare, e.g. a Cloudflare Tunnel
(`cloudflared`) to `http://127.0.0.1:8787`, or a proxied DNS record in front
of your HTTPS reverse proxy. Then add a self-hosted Access application for
that hostname (see [Authentication](#authentication-cloudflare-access)).

Check it: `curl https://link.example.com/health` → `ok` (no token needed), and
`curl -X POST https://link.example.com/mcp` without Access credentials is
stopped by Access; straight to the origin (`curl -X POST
http://127.0.0.1:8787/mcp`) it gets `401`.

### 5. Add it to Claude

claude.ai → Settings → Connectors → Add custom connector with the URL
`https://link.example.com/mcp`, authenticating the way your Access
application's policy allows.

Then ask Claude to sign in to Link (see [Signing in](#signing-in)).

### Updating

    docker compose pull && docker compose up -d

The sign-in is kept in `/data`. **That volume holds a live refresh token for
your financial data**: keep it on the server and out of shared backups.
Shutdown waits for a running link-cli call to finish so a refresh in flight
is saved.

## Running it on Cloud Run

The CI workflow deploys to the Cloud Run service named in its `env:`
(`link-cli-mcp` in `us-south1`). Create the service once; CI only changes its
image. Settings that matter here:

- **`--max-instances=1`**: one process owns the token chain.
- **A persistent volume at `/data`**, e.g. a Cloud Storage bucket mounted as
  a volume (`--add-volume name=auth,type=cloud-storage,bucket=<bucket>
  --add-volume-mount volume=auth,mount-path=/data`). Without one, every new
  instance starts signed out. Use a private bucket only this service's
  runtime account can read.
- The runtime service account needs **Storage Object User** on that bucket.
  The legacy bucket roles can't read objects, and link-cli's save (write a
  temp file, then rename it) fails with `EACCES` without that.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` as env vars (`--set-env-vars`;
  neither is a secret).
- Port 8787 (`--port 8787`), and `--allow-unauthenticated`: Cloud Run's own
  IAM check stays off because the container enforces Cloudflare Access on
  every MCP request. Requests to the `run.app` URL that skip Access get `401`.
- Reach it through a hostname Cloudflare proxies (a custom domain on Cloud
  Run, or a Tunnel), protected by the Access application.

With scale to zero, `KEEPALIVE_MINUTES` does not run while the service is
idle; the session is refreshed on the next call instead.

## Authentication (Cloudflare Access)

Cloudflare Access sits in front of the server. For every request it lets
through, Cloudflare adds a signed JWT in the `Cf-Access-Jwt-Assertion` header.
The server verifies that JWT itself on every MCP request, so a request that
reaches the origin directly (the Cloud Run `run.app` URL, the VPS IP, …)
without going through Access is refused.

- **Token:** `Cf-Access-Jwt-Assertion`, or, if that header is absent,
  `Authorization: Bearer <jwt>` (same checks).
- **Checks:** RS256 only; signature against the team's public keys from
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, matched by
  `kid`; `iss` = `https://<CF_ACCESS_TEAM_DOMAIN>`; `aud` contains one of
  `CF_ACCESS_AUD`; `exp` / `nbf` with 60 s leeway.
- **Keys** are cached for an hour. A token with an unknown `kid` (key
  rotation) triggers a re-fetch, at most once a minute. If a refresh fails,
  the cached keys keep being used.
- **Responses:** no or invalid token → `401` with `WWW-Authenticate: Bearer`
  (the reason is only logged, as `access denied: …`); `CF_ACCESS_*` missing →
  `500`. `/health`, `/healthz` and `/` need no token.

Where to find the settings:

- `CF_ACCESS_AUD`: Zero Trust → Access → Applications → your application →
  Overview → **Application Audience (AUD) Tag**. Several applications in front
  of the same server: comma-separate their tags.
- `CF_ACCESS_TEAM_DOMAIN`: Zero Trust → Settings → Custom Pages → **Team
  domain**, e.g. `myteam.cloudflareaccess.com`. `https://myteam.cloudflareaccess.com`
  and plain `myteam` work too.

Who gets in is decided by the Access application's policies. A client that
can send fixed headers can use an Access service token
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`) with a Service Auth
policy; Access then forwards the request with its JWT.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | (required) | Cloudflare Access team domain (`myteam.cloudflareaccess.com`, a full `https://` URL, or `myteam`) |
| `CF_ACCESS_AUD` | (required) | AUD tag of the Access application; comma-separated for several. The server exits at startup if either is unset |
| `LINK_AUTH_FILE` | `/data/link-auth.json` | link-cli auth file (keep on a persistent volume) |
| `LINK_CLIENT_NAME` | `Claude (read-only)` | Name shown in the Link app when approving sign-in |
| `KEEPALIVE_MINUTES` | `0` | If signed in, do one cheap read this often; `0` = off |
| `LINK_CLI_TIMEOUT_SECONDS` | `60` | Per-call timeout for link-cli |
| `LINK_CLI_BIN` | bundled link-cli | Path to another link-cli `cli.js` (tests use a fake) |
| `PORT` | `8787` | HTTP port |

Endpoints: `POST /mcp` (MCP, Streamable HTTP, JSON responses, stateless) and
`GET /health` (also `/healthz`).

## Data notes (from real use)

These are also sent to Claude in the server's MCP instructions.

- Amounts are integers in cents.
- Bank balance: `cash.available.usd`. Card: `credit.used.usd` = total owed
  **including pending**, as a negative number; `current` = **posted only**.
- Bank transactions: negative = money out. Card: negative = charge, positive
  = payment/refund. Identify card payments by "Payment Thank You" or a
  positive amount ("NTTA Toll Road Payment" is a charge).
- `created_date` can be 1–2 days off the bank's own date; amounts match the
  bank exactly, so reconcile by amount.
- Merchant names are cleaned up ("SAMS CLUB.COM" → "Sam's Club Online").

## Troubleshooting

- **"Not signed in to Link"**: sign in (see above).
- **"session has expired or its refresh token was already used"**: something
  else used the same token chain (a second instance, a copied auth file, a
  restore from backup) or the session lapsed. `sign_in` with
  `replace_existing: true` and approve again.
- **An account is missing from `list_sources`**: it wasn't selected at
  approval. `sign_in` with `mode: "add_access"` and select it.

## Continuous integration

`.github/workflows/container.yml`, on every push to `main` (Markdown-only
changes are skipped), on `v*` tags and pull requests:

1. `npm ci && npm test`;
2. builds the image for linux/amd64 and linux/arm64 and pushes it to GHCR
   (built-in `GITHUB_TOKEN`) and to Google Artifact Registry
   (`GCP_SA_KEY` secret; destination in the workflow's `env:`);
3. on `main`, updates the Cloud Run service named in `env:` to the new image
   (only the image; its settings are kept).

Pull requests are built but not pushed. If you only use a VPS, delete the
Artifact Registry login, its image line and the Cloud Run steps.

---

## Maintainer notes

### Code map

| File | What it does |
|---|---|
| `src/server.js` | Node HTTP server, `/health`, optional keepalive, drains the link-cli queue on shutdown; drops `LINK_*_TOKEN` env vars |
| `src/index.js` | fetch-style handler: Cloudflare Access check, routes `/mcp` |
| `src/access.js` | Cloudflare Access JWT verification (WebCrypto): config, JWKS cache and rotation, claim checks |
| `src/mcp.js` | Stateless MCP over Streamable HTTP (initialize, ping, tools/list, tools/call); server instructions |
| `src/tools.js` | Tool definitions, argument validation, pagination of `transactions list` |
| `src/linkcli.js` | Runs link-cli: command allowlist, one-at-a-time queue, minimal child env, JSON parsing, redaction, error messages |
| `test/` | `node --test`; `fake-link-cli.mjs` stands in for link-cli (state in the auth file, call log next to it); `access-helper.js` makes an RSA key and signs Access-style JWTs |

### link-cli behaviour this relies on (1.3.0)

- `--auth <path>` selects the auth file (same as `LINK_AUTH_FILE`); it holds
  tokens and any pending device sign-in.
- `auth login --format json` returns `verification_url` + `phrase` and
  exits; `auth status` (single check) completes a pending sign-in once
  approved and saves tokens. Both emit a JSON **array** (streamed results).
- `auth login` when already signed in only refreshes and says so; adding
  access needs `auth upgrade` (merges scopes/actions) or `auth logout` first.
- Errors: exit 1 with `{ code, message, cta }` on stdout (e.g.
  `NOT_AUTHENTICATED`).
- Its postinstall runs `npx skills add …`; skipped by `--ignore-scripts` in
  the Dockerfile and by `CI` in GitHub Actions.

When bumping link-cli, recheck these and the command allowlist in
`src/linkcli.js`.

## Development

    npm ci
    npm test        # uses the fake link-cli
    CF_ACCESS_TEAM_DOMAIN=<team> CF_ACCESS_AUD=<aud> LINK_AUTH_FILE=./data/link-auth.json npm start
