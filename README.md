# Cloudflare Telegram Notify Gateway

[English](README.md) | [简体中文](README.zh-CN.md)

A tiny, stateless, secure notification relay that forwards HTTP notifications to Telegram through Cloudflare Workers.

> Upstream owns the message. The gateway securely delivers it.

## Why this exists

Many monitoring tools and small services only need one dependable way to send a notification to one Telegram destination. Running a bot framework, database, dashboard, container, or VPS for that job creates unnecessary maintenance and attack surface.

This project does one thing: accept an authenticated HTTP request and call Telegram's `sendMessage` or `sendDocument` API using a destination and bot token controlled by Worker secrets.

## Features

- Cloudflare-native and stateless
- No database, KV, D1, Durable Objects, queues, cron, Docker, or frontend
- Zero runtime npm dependencies
- Bearer-token authentication with constant-time comparison
- Native MonitorFlare `monitor.down`, `monitor.warning`, and `monitor.up` webhook support
- Plain-text pass-through with no automatic formatting
- Upload PDFs, images, and other documents as original-quality files via `sendDocument`
- A small allowlist of safe JSON presentation options
- One secret-configured Telegram destination
- Optional Telegram forum topic support
- 64 KiB request limit and explicit 4,096-character message limit
- 50 MB multipart upload limit and 1,024-character caption limit
- Safe, consistent JSON errors and request correlation IDs
- Cloudflare runtime tests with all Telegram requests mocked

## Architecture

```mermaid
flowchart LR
    A[Monitoring / Services] --> B[Cloudflare Worker]
    B --> C[Telegram Bot API]
    C --> D[Telegram Chat / Channel]
```

The Worker exposes `GET /health`, `POST /v1/notify`, and `POST /v1/file`. It stores no state and never receives Telegram updates. The caller cannot choose the bot or chat, but may choose a topic within the configured chat.

## Quick start

Requirements: Node.js 20 or newer, npm, and a Cloudflare account.

```sh
npm install
cp .dev.vars.example .dev.vars
npm test
npx wrangler dev
```

Replace the safe placeholders in `.dev.vars` for local development. `.dev.vars` is ignored by Git.

## Cloudflare deployment

Log in and deploy the Worker:

```sh
npx wrangler login
npx wrangler deploy
```

Then configure the required production secrets:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put GATEWAY_SECRET
```

For a Telegram forum topic only:

```sh
npx wrangler secret put TELEGRAM_MESSAGE_THREAD_ID
```

The first deployment can be uploaded before secrets exist, but notification delivery returns a safe configuration error until the required secrets are set. No Cloudflare account ID is hardcoded; Wrangler uses the account selected during login.

## Telegram setup

1. Create a bot with Telegram's official [@BotFather](https://t.me/BotFather).
2. Copy the bot token into the `TELEGRAM_BOT_TOKEN` Worker secret.
3. Add the bot to the target private chat, group, supergroup, or channel.
4. Set the destination ID as `TELEGRAM_CHAT_ID`.

Keep the token private. This gateway sends messages only; it does not use a webhook, poll updates, or handle commands.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot API token issued by BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Single configured chat, group, or channel destination |
| `GATEWAY_SECRET` | Yes | Long random Bearer token shared with trusted callers |
| `OPS_LEDGER_SECRET` | No | Optional second Bearer token. When set, either secret authorizes a request |
| `TELEGRAM_MESSAGE_THREAD_ID` | No | Default forum topic ID. Overridden by the `thread_id` query parameter |

Use long, randomly generated values for `GATEWAY_SECRET` and, when set, `OPS_LEDGER_SECRET`. Either token authorizes `POST /v1/notify` and `POST /v1/file`. Never commit `.dev.vars`, tokens, real chat IDs, or production secrets.

## Sending notifications

Every request to `POST /v1/notify` or `POST /v1/file` needs:

```text
Authorization: Bearer YOUR_GATEWAY_SECRET
```

The secret is accepted only in this header—not in a URL, query parameter, or request body. An optional `X-Notify-Source` header may be included in structured logs; it is never added to the Telegram message.

### Forum topic

Pass `thread_id` as a query parameter to deliver that request to a Telegram forum topic:

```text
POST /v1/notify?thread_id=12
POST /v1/file?thread_id=12
```

The value must be a positive integer. The gateway sends it as `message_thread_id` and uses it instead of `TELEGRAM_MESSAGE_THREAD_ID` for that request. When `thread_id` is absent, the gateway uses `TELEGRAM_MESSAGE_THREAD_ID` if that secret is set, and otherwise sends the message with no topic. A present value that is not a positive integer, including an empty `thread_id`, is rejected with 400 `invalid_thread_id` and is not sent to Telegram. The JSON body does not accept `thread_id` or `message_thread_id`.

### Plain-text example

With `Content-Type: text/plain`, the entire request body becomes Telegram's `text` field. Newlines, emoji, underscores, and asterisks are preserved. No parse mode is set.

```text
🔴 Website Down
example.com
HTTP 500
```

### JSON example

```json
{
  "text": "<b>Website Down</b>\nexample.com",
  "parse_mode": "HTML",
  "disable_notification": false,
  "protect_content": true
}
```

`text` is required. The only optional fields are `parse_mode` (`HTML` or `MarkdownV2`), `disable_notification`, and `protect_content`. Unknown fields and destination-like fields such as `chat_id`, `bot_token`, and `token` are rejected.

The gateway does not format your notification by default. Whatever text the upstream service sends is what Telegram receives.

### MonitorFlare webhook

The gateway directly accepts MonitorFlare's native generic-webhook JSON; no MonitorFlare changes are required. It validates the `event`, `monitor`, `status`, `detail`, and `timestamp` fields and converts `monitor.down` / `monitor.warning` / `monitor.up` events into readable plain-text Telegram notifications.

Configure a generic Webhook channel in MonitorFlare with:

- Webhook URL: `https://gateway.almostsafe.com/v1/notify`
- Method: `POST`
- Headers: `{"Authorization":"Bearer YOUR_GATEWAY_SECRET"}`

The adapter does not accept bot tokens, chat IDs, or other Telegram destination overrides.

### curl examples

Plain text:

```sh
curl -X POST \
  https://YOUR-WORKER.workers.dev/v1/notify \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: text/plain" \
  --data-binary $'🔴 Website Down\nexample.com\nHTTP 500'
```

JSON:

```sh
curl -X POST \
  https://YOUR-WORKER.workers.dev/v1/notify \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: application/json" \
  --data-binary '{"text":"<b>Website Down</b>\nexample.com","parse_mode":"HTML"}'
```

Successful response:

```json
{
  "ok": true,
  "message_id": 123
}
```

### File upload

Send one file to `POST /v1/file` using `multipart/form-data`. PDFs, images, and other documents are forwarded through Telegram's `sendDocument` API, preserving their filename, content type, and original bytes. Images arrive as files in original quality.

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | Yes | One non-empty file |
| `caption` | No | Text of at most 1,024 Unicode characters |
| `parse_mode` | No | `HTML` or `MarkdownV2` |

Unknown fields are rejected with `unsupported_field`; `chat_id`, `bot_token`, and `token` are rejected with `destination_override`. Duplicate fields are rejected. The entire multipart body, including its overhead, must not exceed 50 MB (50 × 1,024 × 1,024 bytes). The limit is checked against `Content-Length` and while reading the body. The notification endpoint retains its 64 KiB limit.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  -F file=@report.pdf \
  -F caption=Report \
  https://YOUR-WORKER.workers.dev/v1/file
```

Let curl set the multipart content type and boundary. Authentication, `?thread_id=` overrides and default topic behavior, success responses, errors, and safe logging follow the notification endpoint.

## Channel setup

To post to a Telegram channel:

1. Add the bot as a channel administrator.
2. Grant it permission to post messages.
3. Configure the channel chat ID in `TELEGRAM_CHAT_ID`.
4. Note that private channel IDs commonly begin with `-100`.

A topic ID is not required for a normal channel.

## Forum topic support

Set `TELEGRAM_MESSAGE_THREAD_ID` to choose the default Telegram forum topic. It must be a positive integer. Leave it unset for private chats, groups without topics, and normal channels.

A caller can choose another topic in the same configured chat for one request with `?thread_id=`. That value overrides the default and must also be a positive integer. The caller still cannot choose the bot or the chat.

## Security model

- `/health` is public and reveals no configuration.
- `/v1/notify` and `/v1/file` require an exact Bearer credential.
- Authentication compares SHA-256 digests in constant time.
- The caller cannot choose the bot or chat. Both are read only from Worker secrets. The caller may choose a topic within the configured chat.
- The JSON API is an allowlist, not a generic Telegram proxy.
- Logs contain no message body, bot token, secret, chat ID, or Authorization header.
- When Telegram rejects a delivery, its error code and description are written to the log and are never returned to callers.
- No permissive CORS headers are emitted. This is a server-to-server API.

Rotate both the gateway secret and bot token if either may have been exposed. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Error responses

Errors use one shape:

```json
{
  "ok": false,
  "error": "machine_readable_code",
  "message": "Human-readable description."
}
```

| HTTP | Typical code | Meaning |
| --- | --- | --- |
| 400 | `invalid_json`, `missing_text`, `missing_file`, `invalid_parse_mode`, `message_too_long`, `caption_too_long`, `invalid_thread_id`, `invalid_payload`, `unsupported_field`, `destination_override` | Invalid caller payload |
| 401 | `unauthorized` | Missing, malformed, or incorrect Bearer token |
| 404 | `not_found` | Unknown path |
| 405 | `method_not_allowed` | Known path with the wrong method |
| 413 | `payload_too_large` | Body exceeds 64 KiB for notifications or 50 MB for file uploads |
| 415 | `unsupported_content_type` | Notifications require `text/plain` or `application/json`; uploads require `multipart/form-data` |
| 429 | `rate_limited` | Telegram rate limit; safe `Retry-After` forwarded when present |
| 500 | `configuration_error` | Required Worker configuration is missing or invalid |
| 502 | `telegram_error` | Telegram or the network rejected delivery |

Every response includes `X-Request-ID`. Telegram credentials and raw Telegram descriptions are never included.

## Logging

The Worker writes small JSON events containing the event name, request ID, HTTP status, and an explicitly provided source name. It prefers Cloudflare's `CF-Ray` value for correlation and otherwise creates a UUID. Notification bodies are not logged.

When Telegram rejects a delivery, the `notification_failed` event also includes Telegram's error code and description as `telegram_error_code` and `telegram_description`. The description is truncated to 200 characters. These values are taken only from Telegram's response body and are never returned to callers. A description that contains the bot token is left out. Network failures do not log the thrown error text.

## Limitations

- One configured Telegram destination
- Text messages and one file per upload
- Maximum 4,096 Unicode characters per message or 1,024 per file caption; never silently truncated or split
- Maximum 64 KiB notification body or 50 MB multipart upload body
- No persistent idempotency: upstream retries can create duplicate Telegram messages
- No automatic retry queue or gateway-side rate limiting
- No browser CORS support by default
- Explicit `HTML` and `MarkdownV2` are forwarded but not validated or escaped by the gateway

## Local development

Copy `.dev.vars.example` to `.dev.vars`, replace its placeholders, and run:

```sh
npm install
npx wrangler dev
```

The current compatibility date is recorded in `wrangler.jsonc`. Update it deliberately and run the full checks before deploying.

## Testing

```sh
npm run typecheck
npm run lint
npm test
```

Tests run in Cloudflare's Workers runtime integration and mock every outbound Telegram request. They do not need Cloudflare or Telegram secrets and never contact the real Telegram API.

## Contributing

Small, focused, well-tested changes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Chinese contribution guidance is available in [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md).

## Security policy

Please report suspected authentication bypass, secret exposure, SSRF, or token leakage privately. See [SECURITY.md](SECURITY.md).

中文版安全政策见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## License

MIT. See [LICENSE](LICENSE).

## Roadmap

Possible future additions—none are part of v1:

- Optional message splitting
- Optional KV-backed idempotency
- Provider, GitHub, Cloudflare, and MonitorFlare adapters
- Apprise-compatible and ntfy-compatible inputs
- Per-source HMAC signatures and source-specific secrets
- Multiple destinations
- Optional retry queue and rate limiting
- Other Telegram media methods

Any addition should preserve the project's small, auditable, stateless default.
