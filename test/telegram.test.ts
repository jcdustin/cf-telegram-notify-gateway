import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage } from "../src/telegram";
import type { Env } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "bot-secret-token",
  TELEGRAM_CHAT_ID: "-1001234567890",
  GATEWAY_SECRET: "gateway-secret",
};

function telegramResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

describe("Telegram delivery", () => {
  it("handles a successful send", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      telegramResponse(200, { ok: true, result: { message_id: 123 } }),
    );
    await expect(sendTelegramMessage({ text: "hello" }, env, fetcher)).resolves.toEqual({
      ok: true,
      messageId: 123,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 500])("maps Telegram HTTP %i to a safe gateway error", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      telegramResponse(status, { ok: false, description: `leak ${env.TELEGRAM_BOT_TOKEN}` }),
    );
    const result = await sendTelegramMessage({ text: "hello" }, env, fetcher);
    expect(result).toEqual({ ok: false, status: 502, code: "telegram_error" });
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it("propagates a safe Telegram retry delay for HTTP 429", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      telegramResponse(429, { ok: false, parameters: { retry_after: 17 } }),
    );
    await expect(sendTelegramMessage({ text: "hello" }, env, fetcher)).resolves.toEqual({
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfter: 17,
    });
  });

  it("omits message_thread_id when it is not configured", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      telegramResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    await sendTelegramMessage({ text: "hello" }, env, fetcher);
    const init = fetcher.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("message_thread_id");
  });

  it("includes a configured forum topic ID", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      telegramResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    await sendTelegramMessage({ text: "hello" }, { ...env, TELEGRAM_MESSAGE_THREAD_ID: "42" }, fetcher);
    const init = fetcher.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload.message_thread_id).toBe(42);
  });

  it("does not expose a token when the network throws it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(env.TELEGRAM_BOT_TOKEN));
    const result = await sendTelegramMessage({ text: "hello" }, env, fetcher);
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});
