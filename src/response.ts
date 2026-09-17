export interface ErrorBody {
  ok: false;
  error: string;
  message: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function jsonResponse(
  body: Record<string, unknown> | ErrorBody,
  status: number,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.set("x-request-id", requestId);
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(
  status: number,
  error: string,
  message: string,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  return jsonResponse({ ok: false, error, message }, status, requestId, extraHeaders);
}
