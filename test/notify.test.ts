import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "telegram-secret-token",
  TELEGRAM_CHAT_ID: "-1001234567890",
  GATEWAY_SECRET: "test-secret",
};

const telegramFetch = vi.fn<typeof fetch>();

function request(
  path: string,
  options: { method?: string; contentType?: string; body?: string; token?: string; headers?: HeadersInit } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) init.body = options.body;
  return new Request(`https://gateway.example${path}`, init);
}

async function dispatch(input: Request, customEnv: Env = env): Promise<Response> {
  return worker.fetch(input, customEnv);
}

function sentPayload(): Record<string, unknown> {
  const init = telegramFetch.mock.calls.at(-1)?.[1];
  if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  telegramFetch.mockReset();
  telegramFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", telegramFetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("health and routing", () => {
  it("returns a public health response without secrets or Telegram calls", async () => {
    const response = await dispatch(request("/health"));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, service: "cf-telegram-notify-gateway" });
    expect(text).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(text).not.toContain(env.TELEGRAM_CHAT_ID);
    expect(text).not.toContain(env.GATEWAY_SECRET);
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a wrong method with Allow", async () => {
    const response = await dispatch(request("/v1/notify", { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 404 for an unknown endpoint", async () => {
    const response = await dispatch(request("/unknown"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("notify authentication", () => {
  it.each([
    ["missing", null],
    ["incorrect", "wrong"],
  ])("rejects %s credentials", async (_label, token) => {
    const options: { method: string; contentType: string; body: string; token?: string } = {
      method: "POST",
      contentType: "text/plain",
      body: "hello",
    };
    if (token !== null) options.token = token;
    const response = await dispatch(
      request("/v1/notify", options),
    );
    expect(response.status).toBe(401);
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: "hello",
        headers: { authorization: "Basic test-secret" },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("plain-text notifications", () => {
  it.each([
    "hello",
    "line one\nline two\n",
    "🔴 emoji remains",
    "server_name_prod_01 *literal*",
  ])("delivers text unchanged: %s", async (text) => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain; charset=utf-8",
        body: text,
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(200);
    expect(sentPayload()).toMatchObject({ chat_id: env.TELEGRAM_CHAT_ID, text });
    expect(sentPayload()).not.toHaveProperty("parse_mode");
  });

  it("passes the acceptance message through exactly", async () => {
    const text = "🔴 Website Down\nPiedmont Ridge Roofing\nhttps://example.com\n\nHTTP check failed\nFailed: 3 consecutive checks";
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: text,
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(200);
    expect(sentPayload().text).toBe(text);
  });

  it("rejects empty text", async () => {
    const response = await dispatch(
      request("/v1/notify", { method: "POST", contentType: "text/plain", body: "", token: "test-secret" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_text" });
  });
});

describe("JSON notifications", () => {
  it("delivers a minimal multiline message", async () => {
    const text = "hello\nworld";
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ text }),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(200);
    expect(sentPayload().text).toBe(text);
  });

  it.each(["HTML", "MarkdownV2"])("forwards explicit %s parse mode", async (parseMode) => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ text: "hello", parse_mode: parseMode }),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(200);
    expect(sentPayload().parse_mode).toBe(parseMode);
  });

  it("rejects an unknown parse mode", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ text: "hello", parse_mode: "Markdown" }),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_parse_mode" });
  });

  it.each(["chat_id", "bot_token", "token"])("rejects destination override field %s", async (field) => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ text: "hello", [field]: "attacker-value" }),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "destination_override" });
  });

  it("rejects arbitrary Telegram API fields", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ text: "hello", reply_markup: {} }),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unsupported_field" });
  });

  it.each([
    [
      "monitor.down",
      "🔴 MonitorFlare 告警\n名称：SubsTracker\n地址：https://tracker.example/health\n状态：故障\n详情：HTTP 503\n时间：2026-09-17 15:00:00",
    ],
    [
      "monitor.up",
      "🟢 MonitorFlare 恢复\n名称：SubsTracker\n地址：https://tracker.example/health\n状态：正常\n详情：HTTP 200\n时间：2026-09-17 15:05:00",
    ],
  ])("adapts a MonitorFlare %s webhook", async (event, expectedText) => {
    const isDown = event === "monitor.down";
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        token: "test-secret",
        body: JSON.stringify({
          event,
          monitor: { name: "SubsTracker", url: "https://tracker.example/health" },
          status: isDown ? "故障" : "正常",
          detail: isDown ? "HTTP 503" : "HTTP 200",
          timestamp: isDown ? "2026-09-17 15:00:00" : "2026-09-17 15:05:00",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(sentPayload()).toMatchObject({ chat_id: env.TELEGRAM_CHAT_ID, text: expectedText });
    expect(sentPayload()).not.toHaveProperty("parse_mode");
  });

  it("rejects malformed MonitorFlare webhook data", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        token: "test-secret",
        body: JSON.stringify({
          event: "monitor.unknown",
          monitor: { name: "SubsTracker", url: "https://tracker.example/health" },
          status: "unknown",
          detail: "",
          timestamp: "now",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_payload" });
    expect(telegramFetch).not.toHaveBeenCalled();
  });
});

describe("request validation and Telegram failures", () => {
  it("rejects an unsupported content type", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: "text=hello",
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rejects malformed JSON", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "application/json",
        body: "{",
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("rejects oversized bodies", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: "x".repeat(65 * 1024),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
  });

  it("rejects messages longer than Telegram's limit", async () => {
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: "x".repeat(4097),
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "message_too_long" });
  });

  it.each([400, 403, 500])("returns a safe 502 for Telegram HTTP %i", async (status) => {
    telegramFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: env.TELEGRAM_BOT_TOKEN }), { status }),
    );
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: "hello",
        token: "test-secret",
      }),
    );
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it("returns Telegram rate limiting and a safe Retry-After", async () => {
    telegramFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 9 } }), { status: 429 }),
    );
    const response = await dispatch(
      request("/v1/notify", {
        method: "POST",
        contentType: "text/plain",
        body: "hello",
        token: "test-secret",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limited" });
  });
});
