import { limitRequestBody, PayloadError, validateParseMode } from "./payload";
import type { FileMessage } from "./types";

export const MAX_FILE_BODY_BYTES = 50 * 1024 * 1024;
const MAX_CAPTION_CHARACTERS = 1024;

export async function parseFileRequest(request: Request): Promise<FileMessage> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "multipart/form-data") {
    throw new PayloadError("unsupported_content_type", 415, "Content-Type must be multipart/form-data.");
  }

  let form: FormData;
  try {
    form = await limitRequestBody(request, MAX_FILE_BODY_BYTES, "50 MB").formData();
  } catch (error) {
    if (error instanceof PayloadError) throw error;
    throw new PayloadError("invalid_payload", 400, "The multipart request payload is invalid.");
  }

  for (const field of ["chat_id", "bot_token", "token"]) {
    if (form.has(field)) {
      throw new PayloadError("destination_override", 400, "Destination override fields are not allowed.");
    }
  }
  for (const field of form.keys()) {
    if (field !== "file" && field !== "caption" && field !== "parse_mode") {
      throw new PayloadError("unsupported_field", 400, "The request contains an unsupported field.");
    }
    if (form.getAll(field).length > 1) {
      throw new PayloadError("invalid_payload", 400, "Each field may only be provided once.");
    }
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new PayloadError("missing_file", 400, "A non-empty file is required.");
  }
  const message: FileMessage = { file };
  const caption = form.get("caption");
  if (caption !== null) {
    if (typeof caption !== "string") {
      throw new PayloadError("invalid_payload", 400, "caption must be a string.");
    }
    // Each code point uses at most two UTF-16 units; reject large text parts before allocating an array.
    if (caption.length > MAX_CAPTION_CHARACTERS * 2 || Array.from(caption).length > MAX_CAPTION_CHARACTERS) {
      throw new PayloadError("caption_too_long", 400, "Telegram captions may not exceed 1024 characters.");
    }
    message.caption = caption;
  }
  const parseMode = form.get("parse_mode");
  if (parseMode !== null) message.parse_mode = validateParseMode(parseMode);
  return message;
}
