const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function isAuthorized(header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match?.[1]) return false;
  const [providedHash, expectedHash] = await Promise.all([digest(match[1]), digest(secret)]);
  return equalBytes(providedHash, expectedHash);
}
