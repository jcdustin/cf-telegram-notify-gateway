import type { Env, FileMessage, NotifyMessage, TelegramResponse, TelegramSendMessage } from "./types";

export type DeliveryResult =
  | { ok: true; messageId: number }
  | { ok: false; status: 429; code: "rate_limited"; retryAfter?: number }
  | {
      ok: false;
      status: 502;
      code: "telegram_error";
      telegramErrorCode?: number;
      telegramDescription?: string;
    }
  | { ok: false; status: 500; code: "configuration_error" };

export function parseThreadId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 86_400
    ? value
    : undefined;
}

const TELEGRAM_DESCRIPTION_LIMIT = 200;

function safeTelegramErrorCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function safeTelegramDescription(value: unknown, botToken: string): string | undefined {
  if (typeof value !== "string") return undefined;
  // Logged as-is. Omit it when it contains the bot token so the secret cannot be recorded.
  if (botToken !== "" && value.includes(botToken)) return undefined;
  return value.length <= TELEGRAM_DESCRIPTION_LIMIT ? value : value.slice(0, TELEGRAM_DESCRIPTION_LIMIT);
}

function telegramErrorResult(body: TelegramResponse | undefined, botToken: string): DeliveryResult {
  if (body?.ok !== false) return { ok: false, status: 502, code: "telegram_error" };

  const telegramErrorCode = safeTelegramErrorCode(body.error_code);
  const telegramDescription = safeTelegramDescription(body.description, botToken);
  if (telegramErrorCode !== undefined && telegramDescription !== undefined) {
    return { ok: false, status: 502, code: "telegram_error", telegramErrorCode, telegramDescription };
  }
  if (telegramErrorCode !== undefined) {
    return { ok: false, status: 502, code: "telegram_error", telegramErrorCode };
  }
  if (telegramDescription !== undefined) {
    return { ok: false, status: 502, code: "telegram_error", telegramDescription };
  }
  return { ok: false, status: 502, code: "telegram_error" };
}

async function sendTelegram(
  message: NotifyMessage | FileMessage,
  env: Env,
  fetcher: typeof fetch = fetch,
  threadIdOverride?: number,
): Promise<DeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, status: 500, code: "configuration_error" };
  }

  let threadId: number | undefined;
  if (threadIdOverride !== undefined) {
    threadId = threadIdOverride;
  } else {
    const configured = env.TELEGRAM_MESSAGE_THREAD_ID;
    if (configured !== undefined && configured !== "") {
      const parsed = parseThreadId(configured);
      if (parsed === null) return { ok: false, status: 500, code: "configuration_error" };
      threadId = parsed;
    }
  }

  let init: RequestInit;
  let method: string;
  if ("file" in message) {
    const form = new FormData();
    form.set("chat_id", env.TELEGRAM_CHAT_ID);
    form.set("document", message.file, message.file.name);
    if (message.caption !== undefined) form.set("caption", message.caption);
    if (message.parse_mode !== undefined) form.set("parse_mode", message.parse_mode);
    if (threadId !== undefined) form.set("message_thread_id", String(threadId));
    method = "sendDocument";
    init = { method: "POST", body: form };
  } else {
    const payload: TelegramSendMessage = { chat_id: env.TELEGRAM_CHAT_ID, ...message };
    if (threadId !== undefined) payload.message_thread_id = threadId;
    method = "sendMessage";
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  }

  let response: Response;
  try {
    response = await fetcher(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      init,
    );
  } catch {
    // Thrown error text can include the request URL, which contains the bot token.
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
  return telegramErrorResult(body, env.TELEGRAM_BOT_TOKEN);
}

export async function sendTelegramMessage(
  message: NotifyMessage,
  env: Env,
  fetcher: typeof fetch = fetch,
  threadIdOverride?: number,
): Promise<DeliveryResult> {
  return sendTelegram(message, env, fetcher, threadIdOverride);
}

export async function sendTelegramDocument(
  message: FileMessage,
  env: Env,
  fetcher: typeof fetch = fetch,
  threadIdOverride?: number,
): Promise<DeliveryResult> {
  return sendTelegram(message, env, fetcher, threadIdOverride);
}
