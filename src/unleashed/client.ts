import { buildQuery, signQuery } from "./signature.ts";
import type { UCustomer, UCustomerDeliveryAddresses, UPage, UProduct, UProductPrice, USalesOrder, USellPriceTier, UTax, UWarehouse } from "./types.ts";

export interface UnleashedConfig {
  apiId: string;
  apiKey: string;
  baseUrl?: string;
  clientType?: string;
  pageSize?: number;
  maxRetries?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable for tests (ms). */
  sleep?: (ms: number) => Promise<void>;
}

export class UnleashedError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "UnleashedError";
    this.status = status;
    this.body = body;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export class UnleashedClient {
  private cfg: Required<Omit<UnleashedConfig, "fetch" | "sleep">>;
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(config: UnleashedConfig) {
    if (!config.apiId || !config.apiKey) throw new Error("Unleashed apiId and apiKey are required");
    this.cfg = {
      apiId: config.apiId,
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? "https://api.unleashedsoftware.com").replace(/\/+$/, ""),
      clientType: config.clientType ?? "clearchoice/b2bportal",
      pageSize: config.pageSize ?? 200,
      maxRetries: config.maxRetries ?? 4,
    };
    this.fetchFn = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Signed GET. `path` is e.g. "/Products/2"; params become the signed query string. */
  get<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  /**
   * Signed POST (create). Unleashed signs the query string only, so a POST with no query signs "".
   * Not retried on 5xx: a create that timed out may have gone through. Callers use a fixed Guid in
   * the path so a deliberate retry updates the same record instead of creating a second one.
   */
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Params, body?: unknown): Promise<T> {
    const qs = buildQuery(params);
    const url = `${this.cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-auth-id": this.cfg.apiId,
      "api-auth-signature": signQuery(qs, this.cfg.apiKey),
      "client-type": this.cfg.clientType,
    };

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (res.ok) return (await res.json()) as T;

      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || (method === "GET" && res.status >= 500);
      if (!retryable || attempt >= this.cfg.maxRetries) {
        throw new UnleashedError(`Unleashed ${method} ${path} failed: ${res.status}${text ? ` (${text.slice(0, 300)})` : ""}`, res.status, text.slice(0, 2000));
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await this.sleep(wait);
    }
  }

  /** Walks every page of a list endpoint (Unleashed pages by path: /Resource/{page}). */
  async *paginate<T>(resource: string, params: Params = {}): AsyncGenerator<T> {
    let page = 1;
    for (;;) {
      const data = await this.get<UPage<T>>(`/${resource}/${page}`, { pageSize: this.cfg.pageSize, ...params });
      for (const item of data.Items ?? []) yield item;
      const pages = data.Pagination?.NumberOfPages ?? 1;
      if (page >= pages) return;
      page++;
    }
  }

  async listAll<T>(resource: string, params: Params = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.paginate<T>(resource, params)) out.push(item);
    return out;
  }

  products(opts: { modifiedSince?: string; includeObsolete?: boolean } = {}) {
    return this.listAll<UProduct>("Products", {
      modifiedSince: opts.modifiedSince,
      includeObsolete: opts.includeObsolete ? "true" : undefined,
    });
  }

  customers(opts: { modifiedSince?: string; includeObsolete?: boolean } = {}) {
    return this.listAll<UCustomer>("Customers", {
      modifiedSince: opts.modifiedSince,
      includeObsolete: opts.includeObsolete ? "true" : undefined,
    });
  }

  /** All customer-specific prices, or one customer's with `customerCode`. */
  productPrices(opts: { customerCode?: string; modifiedSince?: string } = {}) {
    return this.listAll<UProductPrice>("ProductPrices", {
      customerCode: opts.customerCode,
      modifiedSince: opts.modifiedSince,
    });
  }

  /** Every customer's Delivery tab, or one customer's (customerCode matches codes starting with the value). */
  customerDeliveryAddresses(opts: { customerCode?: string } = {}) {
    return this.listAll<UCustomerDeliveryAddresses>("CustomerDeliveryAddresses", { customerCode: opts.customerCode });
  }

  /**
   * Sales orders by order date (YYYY-MM-DD). Unleashed returns full orders with lines, so we
   * keep only the fields we need as we go rather than holding thousands of orders in memory.
   */
  async *salesOrders(opts: { startDate: string; endDate?: string }): AsyncGenerator<USalesOrder> {
    for await (const o of this.paginate<USalesOrder>("SalesOrders", { startDate: opts.startDate, endDate: opts.endDate })) {
      yield { OrderNumber: o.OrderNumber, OrderDate: o.OrderDate, OrderStatus: o.OrderStatus, Customer: { CustomerCode: o.Customer?.CustomerCode } };
    }
  }

  async warehouses(): Promise<UWarehouse[]> {
    const data = await this.get<UPage<UWarehouse> | UWarehouse[]>("/Warehouses");
    return Array.isArray(data) ? data : data.Items ?? [];
  }

  async taxes(): Promise<UTax[]> {
    const data = await this.get<UPage<UTax> | UTax[]>("/Taxes");
    return Array.isArray(data) ? data : data.Items ?? [];
  }

  async sellPriceTiers(): Promise<USellPriceTier[]> {
    const data = await this.get<UPage<USellPriceTier> | USellPriceTier[] | { SellPriceTier?: USellPriceTier[] }>(
      "/SellPriceTiers",
    );
    if (Array.isArray(data)) return data;
    if ("Items" in data && Array.isArray(data.Items)) return data.Items;
    if ("SellPriceTier" in data && Array.isArray(data.SellPriceTier)) return data.SellPriceTier;
    return [];
  }
}

/** Unleashed JSON dates look like "/Date(1712345678000)/"; ISO strings are accepted too. */
export function parseUnleashedDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(value);
  if (m) return new Date(Number(m[1]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
