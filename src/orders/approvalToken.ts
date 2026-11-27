// Approval links in emails carry a signed token, so only someone with the email can approve or
// decline. Token = expiry (unix seconds) + HMAC-SHA256(secret, orderId:expiry), base64url.
import { createHmac, timingSafeEqual } from "node:crypto";

const DAY = 86_400;

export function approvalToken(orderId: string, secret: string, validDays = 30, now = Date.now()): string {
  if (!secret) throw new Error("Approval links need a secret (SHOPIFY_API_SECRET)");
  const exp = Math.floor(now / 1000) + validDays * DAY;
  return `${exp}.${sign(orderId, exp, secret)}`;
}

export function verifyApprovalToken(orderId: string, token: string, secret: string, now = Date.now()): "ok" | "expired" | "invalid" {
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{20,})$/.exec(token ?? "");
  if (!m || !secret) return "invalid";
  const exp = Number(m[1]);
  const want = Buffer.from(sign(orderId, exp, secret));
  const got = Buffer.from(m[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "invalid";
  return exp * 1000 < now ? "expired" : "ok";
}

function sign(orderId: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`approve:${orderId}:${exp}`).digest("base64url");
}
