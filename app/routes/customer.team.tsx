import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { customerContext, handleCustomer, json } from "../customer-auth.server";
import { addPerson, removePerson, teamView, updatePerson, type TeamRole } from "../team.server";

// Backend for the customer account page "Site managers" (extension extensions/site-managers).
// Head-office admin only. GET: { people, sites }.
// POST { action: "add", firstName, lastName, email, role, sites[] } | { action: "update", contactId, role, sites[] } | { action: "remove", contactId }

export const loader = ({ request }: LoaderFunctionArgs) =>
  handleCustomer(request, "team", async () => {
    const c = await customerContext(request);
    if (!c.buyer) return c.cors(json({ trade: false }));
    if (!c.isAdmin) return c.cors(json({ trade: true, isAdmin: false, company: c.buyer.companyName }));
    const view = await teamView(c.shop, c.shopify, c.buyer.companyId, c.buyer.email);
    return c.cors(json({ trade: true, isAdmin: true, company: c.buyer.companyName, ...view }));
  });

export const action = ({ request }: ActionFunctionArgs) =>
  handleCustomer(request, "team", async () => {
    const c = await customerContext(request);
    if (!c.buyer || !c.isAdmin) return c.cors(json({ error: "Only your head-office admin can manage site access." }, 403));
    let b: { action?: string; firstName?: string; lastName?: string; email?: string; role?: string; sites?: string[]; contactId?: string };
    try { b = await request.json(); } catch { return c.cors(json({ error: "Bad request" }, 400)); }
    const actor = { name: c.buyer.name, email: c.buyer.email };
    const role: TeamRole = b.role === "admin" ? "admin" : "ordering";
    const sites = Array.isArray(b.sites) ? b.sites.map(String) : [];
    try {
      if (b.action === "add") {
        const r = await addPerson(c.shop, c.shopify, c.buyer.companyId, actor, {
          firstName: String(b.firstName ?? ""), lastName: String(b.lastName ?? ""), email: String(b.email ?? ""), role, sites,
        });
        return c.cors(json({ ok: true, message: `${r.name} can now order for ${r.sites} site${r.sites === 1 ? "" : "s"}. We've emailed them how to log in.` }));
      }
      if (b.action === "update") {
        await updatePerson(c.shop, c.shopify, c.buyer.companyId, actor, { contactId: String(b.contactId ?? ""), role, sites });
        return c.cors(json({ ok: true, message: "Access updated." }));
      }
      if (b.action === "remove") {
        await removePerson(c.shopify, c.buyer.companyId, actor, String(b.contactId ?? ""));
        return c.cors(json({ ok: true, message: "Removed. They can no longer order for your company." }));
      }
      return c.cors(json({ error: "Unknown action" }, 400));
    } catch (e) {
      return c.cors(json({ error: (e as Error).message }, 400));
    }
  });
