import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { MAX_FILE_BODY_BYTES } from "../src/file";
import worker from "../src/index";
import { limitRequestBody } from "../src/payload";
import type { Env } from "../src/types";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "telegram-secret-token",
  TELEGRAM_CHAT_ID: "-1001234567890",
  GATEWAY_SECRET: "test-secret",
};
const telegramFetch = vi.fn<typeof fetch>();
let logSpy: MockInstance<typeof console.log>;
const fileBytes = new Uint8Array([0, 255, 128, 37, 80, 68, 70]);

function uploadForm(): FormData {
  const form = new FormData();
  form.set("file", new File([fileBytes], "report.pdf", { type: "application/pdf" }));
  return form;
}

function request(
  form: FormData = uploadForm(),
  query = "",
  token: string | null = env.GATEWAY_SECRET,
): Request {
  const headers = new Headers();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://gateway.example/v1/file${query}`, { method: "POST", headers, body: form });
}

function sentForm(): FormData {
  const body = telegramFetch.mock.calls.at(-1)?.[1]?.body;
  if (!(body instanceof FormData)) throw new Error("Expected a multipart request body.");
  return body;
}

async function expectRejection(input: Request, status: number, error: string): Promise<void> {
  const response = await worker.fetch(input, env);
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ ok: false, error });
  expect(text).not.toContain(env.TELEGRAM_BOT_TOKEN);
  expect(telegramFetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  telegramFetch.mockReset();
  telegramFetch.mockResolvedValue(Response.json({ ok: true, result: { message_id: 123 } }));
  vi.stubGlobal("fetch", telegramFetch);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("file delivery", () => {
  it.each(["HTML", "MarkdownV2"])("forwards the original file, caption, %s and topic", async (parseMode) => {
    const form = uploadForm();
    form.set("caption", "Report");
    form.set("parse_mode", parseMode);
    const response = await worker.fetch(request(form, "?thread_id=12"), {
      ...env,
      TELEGRAM_MESSAGE_THREAD_ID: "invalid-default",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message_id: 123 });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(telegramFetch).toHaveBeenCalledOnce();
    const [url, init] = telegramFetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`);
    expect(init?.method).toBe("POST");
    // Round-trip through the native encoder to verify the actual multipart metadata.
    const sent = await new Request("https://api.telegram.org", init).formData();
    expect(Array.from(sent.keys()).sort()).toEqual(["caption", "chat_id", "document", "message_thread_id", "parse_mode"]);
    expect(sent.get("chat_id")).toBe(env.TELEGRAM_CHAT_ID);
    expect(sent.get("caption")).toBe("Report");
    expect(sent.get("parse_mode")).toBe(parseMode);
    expect(sent.get("message_thread_id")).toBe("12");
    const file = sent.get("document");
    if (!(file instanceof File)) throw new Error("Expected a document file.");
    expect(file.name).toBe("report.pdf");
    expect(file.type).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(fileBytes);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"notification_delivered"'));
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("Report");
  });

  it("sends an image as a document without optional fields", async () => {
    const form = new FormData();
    form.set("file", new File([fileBytes], "image.png", { type: "image/png" }));
    const response = await worker.fetch(request(form), env);
    expect(response.status).toBe(200);
    expect(Array.from(sentForm().keys()).sort()).toEqual(["chat_id", "document"]);
    const file = sentForm().get("document") as File;
    expect(file.name).toBe("image.png");
    expect(file.type).toBe("image/png");
  });

  it("accepts the optional second Bearer secret", async () => {
    const response = await worker.fetch(request(uploadForm(), "", "second-secret"), {
      ...env,
      OPS_LEDGER_SECRET: "second-secret",
    });
    expect(response.status).toBe(200);
  });

  it("uses the configured topic when the query parameter is absent", async () => {
    const response = await worker.fetch(request(), { ...env, TELEGRAM_MESSAGE_THREAD_ID: "42" });
    expect(response.status).toBe(200);
    expect(sentForm().get("message_thread_id")).toBe("42");
  });

  it("rejects an invalid configured topic", async () => {
    const response = await worker.fetch(request(), { ...env, TELEGRAM_MESSAGE_THREAD_ID: "invalid" });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "configuration_error" });
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("accepts a caption of exactly 1024 Unicode code points", async () => {
    const form = uploadForm();
    form.set("caption", "😀".repeat(1024));
    const response = await worker.fetch(request(form), env);
    expect(response.status).toBe(200);
    expect(sentForm().get("caption")).toBe("😀".repeat(1024));
  });
});

describe("file request validation", () => {
  it.each([null, "wrong-token"])("rejects missing or wrong credentials (%s) before parsing", async (token) => {
    await expectRejection(request(new FormData(), "?thread_id=invalid", token), 401, "unauthorized");
  });

  it.each(["", "abc", "0", "-1", "1.5", "9007199254740992"])("rejects invalid thread_id %j", async (thread) => {
    await expectRejection(request(uploadForm(), `?thread_id=${thread}`), 400, "invalid_thread_id");
  });

  it("rejects a missing file", async () => {
    await expectRejection(request(new FormData()), 400, "missing_file");
  });

  it("rejects an empty file", async () => {
    const form = new FormData();
    form.set("file", new File([], "empty.pdf", { type: "application/pdf" }));
    await expectRejection(request(form), 400, "missing_file");
  });

  it("rejects a text value in the file field", async () => {
    const form = new FormData();
    form.set("file", "report.pdf");
    await expectRejection(request(form), 400, "missing_file");
  });

  it.each(["x", "😀"])("rejects a caption of 1025 %s characters", async (character) => {
    const form = uploadForm();
    form.set("caption", character.repeat(1025));
    await expectRejection(request(form), 400, "caption_too_long");
  });

  it.each(["Markdown", "", "html"])("rejects parse_mode %j", async (parseMode) => {
    const form = uploadForm();
    form.set("parse_mode", parseMode);
    await expectRejection(request(form), 400, "invalid_parse_mode");
  });

  it.each(["caption", "parse_mode"])("rejects file values in %s", async (field) => {
    const form = uploadForm();
    form.set(field, new File(["text"], "text.txt"));
    await expectRejection(request(form), 400, field === "caption" ? "invalid_payload" : "invalid_parse_mode");
  });

  it.each(["unknown", "thread_id", "message_thread_id", env.TELEGRAM_BOT_TOKEN])("rejects unsupported field %s safely", async (field) => {
    const form = uploadForm();
    form.set(field, "value");
    await expectRejection(request(form), 400, "unsupported_field");
  });

  it.each(["chat_id", "bot_token", "token"])("rejects destination override %s before unsupported fields", async (field) => {
    const form = uploadForm();
    form.set("unknown", "value");
    form.set(field, env.TELEGRAM_BOT_TOKEN);
    await expectRejection(request(form), 400, "destination_override");
  });

  it.each(["file", "caption", "parse_mode"])("rejects duplicate %s fields", async (field) => {
    const form = uploadForm();
    if (field !== "file") form.set(field, "first");
    form.append(field, field === "file" ? new File(["another"], "second.pdf") : "second");
    await expectRejection(request(form), 400, "invalid_payload");
  });

  it("rejects content-length over 50 MB before reading the stream", async () => {
    const input = request();
    input.headers.set("content-length", String(MAX_FILE_BODY_BYTES + 1));
    await expectRejection(input, 413, "payload_too_large");
    expect(input.bodyUsed).toBe(false);
  });

  it.each([undefined, "1"])("counts streamed bytes with content-length %s and cancels on overflow", async (declaredLength) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_FILE_BODY_BYTES + 1));
      },
      cancel,
    });
    const headers = new Headers({
      authorization: `Bearer ${env.GATEWAY_SECRET}`,
      "content-type": "multipart/form-data; boundary=test",
    });
    if (declaredLength !== undefined) headers.set("content-length", declaredLength);
    await expectRejection(new Request("https://gateway.example/v1/file", { method: "POST", headers, body }), 413, "payload_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["application/json", "text/plain", "application/x-www-form-urlencoded", ""])("rejects content type %j", async (contentType) => {
    const headers: Record<string, string> = { authorization: `Bearer ${env.GATEWAY_SECRET}` };
    if (contentType) headers["content-type"] = contentType;
    await expectRejection(new Request("https://gateway.example/v1/file", { method: "POST", headers }), 415, "unsupported_content_type");
  });

  it.each(["multipart/form-data", "multipart/form-data; boundary=missing"])("rejects malformed multipart (%s)", async (contentType) => {
    await expectRejection(new Request("https://gateway.example/v1/file", {
      method: "POST",
      headers: { authorization: `Bearer ${env.GATEWAY_SECRET}`, "content-type": contentType },
      body: "not a multipart body",
    }), 400, "invalid_payload");
  });

  it.each(["GET", "PUT", "DELETE"])("rejects %s with Allow: POST", async (method) => {
    const response = await worker.fetch(new Request("https://gateway.example/v1/file", { method }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await expect(response.json()).resolves.toMatchObject({ error: "method_not_allowed" });
    expect(telegramFetch).not.toHaveBeenCalled();
  });
});

describe("file Telegram failures", () => {
  it("logs safe Telegram details without returning them", async () => {
    const description = "Bad Request: document rejected";
    telegramFetch.mockResolvedValueOnce(Response.json({ ok: false, error_code: 400, description }, { status: 400 }));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: "telegram_error" });
    expect(text).not.toContain(description);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"telegram_description":"Bad Request: document rejected"'));
  });

  it.each([400, 403, 500])("does not leak tokens from Telegram HTTP %i", async (status) => {
    telegramFetch.mockResolvedValueOnce(Response.json({ ok: false, description: env.TELEGRAM_BOT_TOKEN }, { status }));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it("does not leak tokens from thrown network errors", async () => {
    telegramFetch.mockRejectedValueOnce(new Error(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it.each([9, undefined])("returns 429 with retry_after %s safely", async (retryAfter) => {
    telegramFetch.mockResolvedValueOnce(Response.json({
      ok: false,
      description: env.TELEGRAM_BOT_TOKEN,
      parameters: { retry_after: retryAfter },
    }, { status: 429 }));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(retryAfter === undefined ? null : String(retryAfter));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: "rate_limited" });
    expect(text).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});

describe("shared streaming body limit", () => {
  it.each([4, 5])("counts multiple chunks against a %i byte limit", async (maxBytes) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const limited = limitRequestBody(new Request("https://gateway.example/v1/file", { method: "POST", body }), maxBytes, "test");
    if (maxBytes === 5) {
      expect(new Uint8Array(await limited.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    } else {
      await expect(limited.arrayBuffer()).rejects.toMatchObject({ code: "payload_too_large", status: 413 });
    }
  });
});
