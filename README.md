# discord-relay

A tiny, runtime-agnostic webhook relay that forwards **Sentry** and **Vercel**
events into **Discord** as clean embeds — for services that don't ship a native
Discord integration.

The core (`core.mjs`) uses only Web-standard APIs (`Request`/`Response`,
`fetch`, `crypto.subtle`), so the same code runs on **Vercel Edge**,
**Cloudflare Workers**, **Node 18+**, **Bun**, and **Deno**. Only a ~3-line
adapter differs per platform.

No secrets live in the code — everything comes from environment variables, so
the repo is safe to keep public while each deployment stays private.

## Routes

| Method | Path       | Source                                   | Posts to (webhook mode)  |
| ------ | ---------- | ---------------------------------------- | ------------------------ |
| POST   | `/sentry`  | Sentry Internal Integration webhook      | `DISCORD_SENTRY_WEBHOOK` |
| POST   | `/vercel`  | Vercel team Webhook                      | `DISCORD_DEPLOY_WEBHOOK` |
| POST   | `/github`  | GitHub repo/org webhook                  | `DISCORD_GITHUB_WEBHOOK` |
| GET    | `/`        | health check                             | —                        |

On Vercel the paths are `/api/sentry`, `/api/vercel`, `/api/github`.

GitHub events surfaced (rest are ignored to cut noise): `push`, `pull_request`
(opened/reopened/closed/merged), `issues` (opened/closed/reopened), `release`
(published), `workflow_run` (failures only). Set the webhook **Content type** to
`application/json`.

## Environment variables

Pick **one delivery mode**:

**Mode A — Webhook** (simplest, one URL per channel):

| Name                     | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `DISCORD_SENTRY_WEBHOOK` | Discord webhook URL for the error channel  |
| `DISCORD_DEPLOY_WEBHOOK` | Discord webhook URL for the deploy channel |

Get a webhook: **Channel → Edit → Integrations → Webhooks → New Webhook → Copy URL.**

**Mode B — Bot** (one token, many channels). Sending is a stateless REST call
(`POST /channels/{id}/messages`), so no Gateway/session is needed — it runs fine
on serverless. If `DISCORD_BOT_TOKEN` is set, it takes precedence over webhooks.

| Name                        | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `DISCORD_BOT_TOKEN`         | Bot token (needs "Send Messages" in the channels) |
| `DISCORD_SENTRY_CHANNEL_ID` | Channel ID for errors                         |
| `DISCORD_DEPLOY_CHANNEL_ID` | Channel ID for deploys                        |

Get a channel ID: enable **Settings → Advanced → Developer Mode**, then
right-click the channel → **Copy Channel ID**.

**Optional (both modes)** — signature verification:

| Name            | Purpose                                   |
| --------------- | ----------------------------------------- |
| `SENTRY_SECRET` | Sentry Client Secret → HMAC-SHA256 verify |
| `VERCEL_SECRET` | Vercel webhook secret → HMAC-SHA1 verify  |

## Deploy

### Vercel (primary)
```bash
vercel                       # link + deploy (functions-only, zero config)
vercel env add DISCORD_SENTRY_WEBHOOK
vercel env add DISCORD_DEPLOY_WEBHOOK
vercel env add VERCEL_SECRET       # optional
vercel env add SENTRY_SECRET       # optional
vercel --prod
```

### Cloudflare Workers
```bash
wrangler deploy
wrangler secret put DISCORD_SENTRY_WEBHOOK
wrangler secret put DISCORD_DEPLOY_WEBHOOK
# ...and the optional secrets
```

### Node / Bun / Deno (self-host)
```bash
DISCORD_SENTRY_WEBHOOK=... DISCORD_DEPLOY_WEBHOOK=... npm start
```

## Wiring the sources

**Sentry** — Settings → Developer Settings → **Internal Integration**:
- Webhook URL: `https://<your-deploy>/api/sentry`
- Enable the **issue/error** webhook events (and alert-rule action)
- Copy the **Client Secret** into `SENTRY_SECRET`

**Vercel** — Team Settings → **Webhooks**:
- Endpoint: `https://<your-deploy>/api/vercel`
- Events: `deployment.error`, `deployment.succeeded`, `deployment.canceled`
- Copy the signing secret into `VERCEL_SECRET`

Preview-environment successes are filtered out by default to cut noise.

## License

MIT
