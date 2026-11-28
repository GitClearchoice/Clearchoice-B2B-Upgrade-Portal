import type { ShopifyGraphql } from "../src/orders/placeOrder.ts";

// Company setting "we don't use purchase orders": company metafield b2b.po_not_required (read by the
// cart block and the order flow), plus who changed it last (b2b.po_not_required_by).
const SET = `#graphql
  mutation PoSetting($m: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $m) { userErrors { field message } }
  }`;

export async function setPoNotRequired(shopify: ShopifyGraphql, companyId: string, notRequired: boolean, by: string) {
  const when = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" });
  const r = await shopify<{ metafieldsSet: { userErrors: { message: string }[] } }>(SET, {
    m: [
      { ownerId: companyId, namespace: "b2b", key: "po_not_required", type: "boolean", value: notRequired ? "true" : "false" },
      { ownerId: companyId, namespace: "b2b", key: "po_not_required_by", type: "single_line_text_field", value: `${notRequired ? "Ticked" : "Unticked"} by ${by}, ${when}`.slice(0, 255) },
    ],
  });
  if (r.metafieldsSet.userErrors.length) throw new Error(r.metafieldsSet.userErrors.map((e) => e.message).join("; "));
}
