import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { UnleashedClient, UnleashedError, parseUnleashedDate } from "../src/unleashed/client.ts";
import { buildQuery, signQuery } from "../src/unleashed/signature.ts";

test("signature is base64 HMAC-SHA256 of the query string only", () => {
  const key = "secret-key";
  const expected = createHmac("sha256", key).update("productCode=ABC&pageSize=200").digest("base64");
  assert.equal(signQuery("productCode=ABC&pageSize=200", key), expected);
  assert.equal(signQuery("?productCode=ABC&pageSize=200", key), expected);
  assert.equal(signQuery("", key), createHmac("sha256", key).update("").digest("base64"));
});

test("buildQuery drops empty values and encodes", () => {
  assert.equal(buildQuery({ a: "x y", b: undefined, c: "", d: 2 }), "a=x%20y&d=2");
});

type Call = { url: string; headers: Record<string, string> };
function fakeFetch(responses: ((url: string) => Response)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return responses[Math.min(i++, responses.length - 1)](url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("client sends signed headers and walks every page", async () => {
  const { fn, calls } = fakeFetch([
    json({ Pagination: { NumberOfItems: 3, PageSize: 2, PageNumber: 1, NumberOfPages: 2 }, Items: [{ ProductCode: "A" }, { ProductCode: "B" }] }),
    json({ Pagination: { NumberOfItems: 3, PageSize: 2, PageNumber: 2, NumberOfPages: 2 }, Items: [{ ProductCode: "C" }] }),
  ]);
  const client = new UnleashedClient({ apiId: "id", apiKey: "key", pageSize: 2, fetch: fn });
  const items = await client.products({ modifiedSince: "2026-11-01" });
  assert.deepEqual(items.map((p) => p.ProductCode), ["A", "B", "C"]);
  assert.equal(calls[0].url, "https://api.unleashedsoftware.com/Products/1?pageSize=2&modifiedSince=2026-11-01");
  assert.equal(calls[1].url, "https://api.unleashedsoftware.com/Products/2?pageSize=2&modifiedSince=2026-11-01");
  assert.equal(calls[0].headers["api-auth-id"], "id");
  assert.equal(calls[0].headers["api-auth-signature"], signQuery("pageSize=2&modifiedSince=2026-11-01", "key"));
  assert.equal(calls[0].headers["client-type"], "clearchoice/b2bportal");
  assert.equal(calls[0].headers.Accept, "application/json");
});

test("client retries 429 and 5xx, then succeeds", async () => {
  const waits: number[] = [];
  const { fn, calls } = fakeFetch([json({}, 429), json({}, 503), json({ Items: [] })]);
  const client = new UnleashedClient({ apiId: "id", apiKey: "key", fetch: fn, sleep: async (ms) => { waits.push(ms); } });
  await client.get("/SellPriceTiers");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("client does not retry 403 and reports the status", async () => {
  const { fn, calls } = fakeFetch([json({ description: "bad signature" }, 403)]);
  const client = new UnleashedClient({ apiId: "id", apiKey: "key", fetch: fn });
  await assert.rejects(client.get("/Customers/1"), (e: unknown) => e instanceof UnleashedError && e.status === 403);
  assert.equal(calls.length, 1);
});

test("sellPriceTiers accepts the shapes Unleashed may return", async () => {
  const tiers = [{ Tier: 1, Name: "Trade" }];
  for (const body of [tiers, { Items: tiers }, { SellPriceTier: tiers }]) {
    const { fn } = fakeFetch([json(body)]);
    const client = new UnleashedClient({ apiId: "id", apiKey: "key", fetch: fn });
    assert.deepEqual(await client.sellPriceTiers(), tiers);
  }
});

test("parses Unleashed /Date()/ and ISO dates", () => {
  assert.equal(parseUnleashedDate("/Date(1764028800000)/")?.toISOString(), "2025-11-25T00:00:00.000Z");
  assert.equal(parseUnleashedDate("2026-11-25T00:00:00Z")?.toISOString(), "2026-11-25T00:00:00.000Z");
  assert.equal(parseUnleashedDate(null), null);
});
