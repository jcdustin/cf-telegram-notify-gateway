# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stateless Cloudflare Worker that relays authenticated HTTP notifications to one Telegram destination via the Bot API `sendMessage` call. Zero runtime npm dependencies; no KV, D1, Durable Objects, queues, or cron.

## Commands

```sh
npm ci                  # install (CI uses Node 22; engines requires >=20)
npm run typecheck       # tsc --noEmit
npm run lint            # eslint, --max-warnings=0
npm test                # vitest run (inside the Workers runtime)
npm run dev             # wrangler dev; needs .dev.vars (copy from .dev.vars.example)
npm run deploy          # wrangler deploy
```

Single test file or test name:

```sh
npx vitest run test/auth.test.ts
npx vitest run -t "rejects oversized bodies"
```

All three of typecheck, lint, and test must pass; the PR template and CI both require them.

## Deployment

**Every push to `main` deploys to production.** `.github/workflows/deploy.yml` reruns typecheck/lint/test and then runs `wrangler deploy` with repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Treat a commit on `main` as a production release.

Worker secrets are set out of band with `wrangler secret put` and are not in `wrangler.jsonc`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GATEWAY_SECRET`, and the optional `TELEGRAM_MESSAGE_THREAD_ID` and `OPS_LEDGER_SECRET`.

## Architecture

Request flow for `POST /v1/notify`, all orchestrated by `handleNotify` in `src/index.ts`:

1. `src/auth.ts` `isAuthorized` — Bearer token checked against every configured secret (`GATEWAY_SECRET`, `OPS_LEDGER_SECRET`) by comparing SHA-256 digests in constant time. Auth runs before the body is read. A failed check is 401 even when `thread_id` is missing or invalid.
2. `thread_id` query parameter — read from `new URL(request.url).searchParams` after authorization. When the parameter is present, including present-but-empty, it must be a string of digits for a positive safe integer. If it is not, `handleNotify` logs `notification_rejected` and returns 400 `invalid_thread_id` without calling Telegram. When the parameter is absent, delivery falls back to `TELEGRAM_MESSAGE_THREAD_ID`, or sends no topic when that secret is unset.
3. `src/payload.ts` `parseNotifyRequest` — turns the request into a `NotifyMessage` or throws `PayloadError(code, status, message)`, which `index.ts` maps directly to the error response. The JSON body does not accept `thread_id` or `message_thread_id`.
4. `src/telegram.ts` `sendTelegramMessage` — never throws; returns a `DeliveryResult` discriminated union (`ok` / `rate_limited` / `telegram_error` / `configuration_error`) that `index.ts` maps to 200 / 429 / 502 / 500. An explicit numeric override is sent as `message_thread_id`, and `TELEGRAM_MESSAGE_THREAD_ID` is not read or validated. With no override, the environment-variable behavior is unchanged.
5. `src/response.ts` — every response goes through `jsonResponse`/`errorResponse`, which attach `X-Request-ID` (the `CF-Ray` value, else a UUID).

`GET /health` is the only other route and is public.

### Payload dispatch (`src/payload.ts`)

- `text/plain`: the raw body is the message text, with no parse mode.
- `application/json`: `chat_id`, `bot_token`, and `token` are rejected first (`destination_override`). Then, if the object has `event` and no `text`, it is handled as a MonitorFlare webhook (`monitor.down` / `monitor.warning` / `monitor.up`) and rendered into fixed Chinese-language plain text. Otherwise it is the generic shape with a strict allowlist: `text`, `parse_mode` (`HTML` | `MarkdownV2`), `disable_notification`, `protect_content`.
- Unknown fields are rejected in both JSON shapes (`unsupported_field`) — this is an allowlist API, not a Telegram proxy.
- Limits: 64 KiB body (checked via `Content-Length` and again while streaming), 4,096 characters counted as Unicode code points. Messages are never truncated or split.

### Invariants to preserve

These are the project's security model (README "Security model", CONTRIBUTING "Design boundaries"):

- The caller can never choose the bot or chat; both come only from Worker secrets. The caller may choose a topic within the configured chat with the `thread_id` query parameter.
- Logs are the small JSON record built by `log()` in `index.ts` (event, request ID, status, optional `X-Notify-Source`). Never log message bodies, tokens, chat IDs, thread IDs, the Authorization header, or thrown error text. On `notification_failed`, when Telegram's response body has `ok: false`, the record also includes `telegram_error_code` and `telegram_description` (description truncated to 200 characters) when those fields are present and safe. A description that contains the bot token is omitted. These fields are never returned to callers.
- Raw Telegram error descriptions and thrown network errors are never returned to callers; they collapse to `telegram_error`. The bot token is part of the Telegram URL, so thrown error text can contain it and must not be logged.
- No CORS headers; this is a server-to-server API.
- No runtime dependencies, storage, frameworks, or automatic formatting without prior agreement.

## Tests

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`, configured from `wrangler.jsonc`. They must never reach the real Telegram API or need real secrets.

- `test/notify.test.ts` drives the Worker's `fetch` handler end to end with `vi.stubGlobal("fetch", ...)` and a silenced `console.log`.
- `test/telegram.test.ts` uses the injectable third `fetcher` parameter of `sendTelegramMessage` instead of stubbing the global. An optional fourth argument overrides the forum topic.

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: omit an optional property rather than assigning `undefined` (see how `retryAfter` and `message_thread_id` are built in `telegram.ts`).
- ESLint enforces `consistent-type-imports` (use `import type`) and bans `any`.
- Plain functions and native Web APIs only.
- Public behavior changes need matching updates to `README.md`, `README.zh-CN.md`, and `CHANGELOG.md`; the docs are maintained in English and Simplified Chinese (`*.zh-CN.md`).
