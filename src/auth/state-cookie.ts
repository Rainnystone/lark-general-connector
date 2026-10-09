import { base64UrlToBytes, base64UrlToText, bytesToBase64Url, textToBase64Url } from "../encoding";

const TEN_MINUTES_MS = 10 * 60 * 1000;

export async function stateCookieName(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return `__Host-feishu-state-${hex.slice(0, 32)}`;
}

export interface StatePayload {
  state: string;
  exp: number;
  nonce: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sealStateCookie(payload: StatePayload, secret: string): Promise<string> {
  const encoded = textToBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function openStateCookie(sealed: string, secret: string): Promise<StatePayload | null> {
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = sealed.slice(0, dot);
  const signature = sealed.slice(dot + 1);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, new TextEncoder().encode(encoded));
  if (!valid) return null;
  try {
    const parsed = JSON.parse(base64UrlToText(encoded)) as Partial<StatePayload>;
    if (typeof parsed.state !== "string" || typeof parsed.exp !== "number" || typeof parsed.nonce !== "string") return null;
    return { state: parsed.state, exp: parsed.exp, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

export function stateCookieHeader(name: string, sealed: string): string {
  return `${name}=${sealed}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function stateExpiry(now = Date.now()): number {
  return now + TEN_MINUTES_MS;
}
