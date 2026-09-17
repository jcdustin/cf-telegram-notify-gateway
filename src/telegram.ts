import type { Env, NotifyMessage, TelegramResponse, TelegramSendMessage } from "./types";

export type DeliveryResult =
  | { ok: true; messageId: number }
  | { ok: false; status: 429; code: "rate_limited"; retryAfter?: number }
  | { ok: false; status: 502; code: "telegram_error" }
  | { ok: false; status: 500; code: "configuration_error" };

function parseThreadId(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 86_400
    ? value
    : undefined;
}

export async function sendTelegramMessage(
  message: NotifyMessage,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, status: 500, code: "configuration_error" };
  }
  const threadId = parseThreadId(env.TELEGRAM_MESSAGE_THREAD_ID);
  if (threadId === null) return { ok: false, status: 500, code: "configuration_error" };

  const payload: TelegramSendMessage = { chat_id: env.TELEGRAM_CHAT_ID, ...message };
  if (threadId !== undefined) payload.message_thread_id = threadId;

  let response: Response;
  try {
    response = await fetcher(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return { ok: false, status: 502, code: "telegram_error" };
  }

  let body: TelegramResponse | undefined;
  try {
    body = await response.json<TelegramResponse>();
  } catch {
    body = undefined;
  }

  if (response.ok && body?.ok === true && Number.isSafeInteger(body.result.message_id)) {
    return { ok: true, messageId: body.result.message_id };
  }
  if (response.status === 429) {
    const bodyRetry = body?.ok === false ? safeRetryAfter(body.parameters?.retry_after) : undefined;
    const headerRetry = Number(response.headers.get("retry-after"));
    const retryAfter = bodyRetry ?? safeRetryAfter(headerRetry);
    return retryAfter === undefined
      ? { ok: false, status: 429, code: "rate_limited" }
      : { ok: false, status: 429, code: "rate_limited", retryAfter };
  }
  return { ok: false, status: 502, code: "telegram_error" };
}
