import type { NotifyMessage } from "./types";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARACTERS = 4096;

export class PayloadError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PayloadError";
  }
}

async function readLimitedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
      throw new PayloadError("payload_too_large", 413, "Request body exceeds the 64 KiB limit.");
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PayloadError("payload_too_large", 413, "Request body exceeds the 64 KiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PayloadError("invalid_body", 400, "Request body must be valid UTF-8.");
  }
}

function validateText(text: unknown): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new PayloadError("missing_text", 400, "A non-empty text value is required.");
  }
  if (Array.from(text).length > MAX_MESSAGE_CHARACTERS) {
    throw new PayloadError("message_too_long", 400, "Telegram messages may not exceed 4096 characters.");
  }
  return text;
}

function parseJson(raw: string): NotifyMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new PayloadError("invalid_json", 400, "Request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError("invalid_json", 400, "JSON body must be an object.");
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(["text", "parse_mode", "disable_notification", "protect_content"]);
  const dangerous = new Set(["chat_id", "bot_token", "token"]);
  for (const key of Object.keys(input)) {
    if (dangerous.has(key)) {
      throw new PayloadError("destination_override", 400, `Field '${key}' is not allowed.`);
    }
    if (!allowed.has(key)) {
      throw new PayloadError("unsupported_field", 400, `Field '${key}' is not supported.`);
    }
  }

  const message: NotifyMessage = { text: validateText(input.text) };
  if (input.parse_mode !== undefined) {
    if (input.parse_mode !== "HTML" && input.parse_mode !== "MarkdownV2") {
      throw new PayloadError("invalid_parse_mode", 400, "parse_mode must be HTML or MarkdownV2.");
    }
    message.parse_mode = input.parse_mode;
  }
  for (const field of ["disable_notification", "protect_content"] as const) {
    const fieldValue = input[field];
    if (fieldValue !== undefined && typeof fieldValue !== "boolean") {
      throw new PayloadError("invalid_payload", 400, `${field} must be a boolean.`);
    }
    if (typeof fieldValue === "boolean") message[field] = fieldValue;
  }
  return message;
}

export async function parseNotifyRequest(request: Request): Promise<NotifyMessage> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/plain" && contentType !== "application/json") {
    throw new PayloadError(
      "unsupported_content_type",
      415,
      "Content-Type must be text/plain or application/json.",
    );
  }
  const raw = await readLimitedBody(request);
  return contentType === "text/plain" ? { text: validateText(raw) } : parseJson(raw);
}
