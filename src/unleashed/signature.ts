import { createHmac } from "node:crypto";

/**
 * Unleashed signs each request with HMAC-SHA256 over the query string only
 * (everything after "?", without the "?"), keyed with the API key, base64-encoded.
 * A request with no query string signs the empty string.
 */
export function signQuery(queryString: string, apiKey: string): string {
  const qs = queryString.startsWith("?") ? queryString.slice(1) : queryString;
  return createHmac("sha256", apiKey).update(qs, "utf8").digest("base64");
}

/** Builds the query string exactly as it will be sent, so the signature matches. */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}
