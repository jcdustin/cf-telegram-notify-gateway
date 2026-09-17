import { isAuthorized } from "./auth";
import { parseNotifyRequest, PayloadError } from "./payload";
import { errorResponse, jsonResponse } from "./response";
import { sendTelegramMessage } from "./telegram";
import type { Env } from "./types";

function requestId(request: Request): string {
  const ray = request.headers.get("cf-ray");
  return ray && ray.length <= 128 ? ray : crypto.randomUUID();
}

function log(event: string, requestIdValue: string, status: number, source?: string): void {
  const record: Record<string, string | number> = { event, request_id: requestIdValue, status };
  if (source) record.source = source.slice(0, 100);
  console.log(JSON.stringify(record));
}

async function handleNotify(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await isAuthorized(request.headers.get("authorization"), env.GATEWAY_SECRET))) {
    log("notification_rejected", id, 401);
    return errorResponse(401, "unauthorized", "A valid Bearer token is required.", id);
  }

  let message;
  try {
    message = await parseNotifyRequest(request);
  } catch (error) {
    if (error instanceof PayloadError) {
      log("notification_rejected", id, error.status);
      return errorResponse(error.status, error.code, error.message, id);
    }
    log("notification_rejected", id, 400);
    return errorResponse(400, "invalid_payload", "The request payload is invalid.", id);
  }

  const result = await sendTelegramMessage(message, env);
  const source = request.headers.get("x-notify-source") ?? undefined;
  if (result.ok) {
    log("notification_delivered", id, 200, source);
    return jsonResponse({ ok: true, message_id: result.messageId }, 200, id);
  }
  if (result.code === "rate_limited") {
    log("notification_rate_limited", id, 429, source);
    const headers = result.retryAfter === undefined ? undefined : { "retry-after": String(result.retryAfter) };
    return errorResponse(429, "rate_limited", "Telegram rate limited the request.", id, headers);
  }
  const messageText = result.code === "configuration_error"
    ? "The gateway is not configured correctly."
    : "Telegram could not deliver the notification.";
  log("notification_failed", id, result.status, source);
  return errorResponse(result.status, result.code, messageText, id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = requestId(request);
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Only GET is allowed for this endpoint.", id, {
          allow: "GET",
        });
      }
      return jsonResponse({ ok: true, service: "cf-telegram-notify-gateway" }, 200, id);
    }
    if (pathname === "/v1/notify") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "Only POST is allowed for this endpoint.", id, {
          allow: "POST",
        });
      }
      return handleNotify(request, env, id);
    }
    return errorResponse(404, "not_found", "Endpoint not found.", id);
  },
} satisfies ExportedHandler<Env>;
