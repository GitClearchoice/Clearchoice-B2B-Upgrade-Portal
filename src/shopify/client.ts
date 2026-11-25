// Shopify GraphQL Admin API client for server-side scripts.
// Token: client credentials grant (Dev Dashboard app installed on a store in the same organization).

export interface ShopifyConfig {
  shop: string; // e.g. clearchoice-upgrade.myshopify.com
  clientId?: string;
  clientSecret?: string;
  /** Use a token you already have instead of the client credentials grant. */
  accessToken?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class ShopifyError extends Error {
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ShopifyError";
    this.details = details;
  }
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export class ShopifyAdmin {
  private shop: string;
  private cfg: ShopifyConfig;
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private token: string | null;
  private tokenExpiresAt = 0;
  readonly apiVersion: string;

  constructor(cfg: ShopifyConfig) {
    this.shop = cfg.shop.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!/\.myshopify\.com$/.test(this.shop)) throw new Error(`Shop must be the *.myshopify.com domain (got ${cfg.shop})`);
    if (!cfg.accessToken && !(cfg.clientId && cfg.clientSecret)) {
      throw new Error("Shopify needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ACCESS_TOKEN)");
    }
    this.cfg = cfg;
    this.apiVersion = cfg.apiVersion ?? "2026-10";
    this.fetchFn = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = cfg.accessToken ?? null;
    if (this.token) this.tokenExpiresAt = Number.POSITIVE_INFINITY;
  }

  get shopDomain() {
    return this.shop;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await this.fetchFn(`https://${this.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId!,
        client_secret: this.cfg.clientSecret!,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ShopifyError(
        `Couldn't get a Shopify access token (${res.status}). Check the client ID/secret, that the app is installed on ${this.shop}, and that the app and store are in the same organization.`,
        text.slice(0, 500),
      );
    }
    const data = JSON.parse(text) as { access_token: string; expires_in?: number; scope?: string };
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 86_400) * 1000;
    return this.token;
  }

  /** Runs a GraphQL query/mutation. Retries throttling and 5xx. Throws on top-level GraphQL errors. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.fetchFn(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= max) throw new ShopifyError(`Shopify API ${res.status} after ${max} retries`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = (await res.json()) as {
        data?: T;
        errors?: { message: string; extensions?: { code?: string } }[];
        extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
      };
      if (body.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
        if (attempt >= max) throw new ShopifyError("Shopify API throttled after retries");
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok || body.errors?.length) {
        const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
        const scopeHint = /access denied|scope/i.test(msg) ? " (check the app's access scopes in the Dev Dashboard and reinstall)" : "";
        throw new ShopifyError(`Shopify GraphQL error: ${msg}${scopeHint}`, body.errors);
      }
      // Be polite: if the bucket is nearly empty, wait for it to refill a little.
      const t = body.extensions?.cost?.throttleStatus;
      if (t && t.currentlyAvailable < 100) await this.sleep(Math.ceil(((100 - t.currentlyAvailable) / t.restoreRate) * 1000));
      return body.data as T;
    }
  }
}

/** Throws if a mutation returned userErrors. */
export function assertNoUserErrors(what: string, errors: UserError[] | null | undefined): void {
  if (errors?.length) {
    throw new ShopifyError(`${what}: ${errors.map((e) => `${e.message}${e.field ? ` (${e.field.join(".")})` : ""}`).join("; ")}`, errors);
  }
}
