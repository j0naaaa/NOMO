import type { PendingOrderStatus, PendingOrderView } from "@nomo/shared";

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incomplete broker response.");
  }
  return value as Fields;
}

export function brokerData(raw: unknown): Fields {
  const root = fields(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (root.next || root.next_cursor || root.has_more) throw new Error("Incomplete broker page.");
  const data = root.data === undefined ? root : fields(root.data);
  if (data.next || data.next_cursor || data.has_more) throw new Error("Incomplete broker page.");
  return data;
}

export function rows(raw: unknown, key: string): Fields[] {
  const values = brokerData(raw)[key];
  if (!Array.isArray(values)) throw new Error("Broker did not return " + key + ".");
  return values.map(fields);
}

function number(value: unknown, label: string): number {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim() ||
      !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error("Invalid " + label + ".");
  return Number(value);
}

function positive(value: unknown, label: string): number {
  const n = number(value, label);
  if (!n) throw new Error("Missing positive " + label + ".");
  return n;
}

export function dollarLimits() {
  return {
    order: positive(process.env.NOMO_MAX_ORDER_USD, "NOMO_MAX_ORDER_USD limit"),
    position: positive(process.env.NOMO_MAX_POSITION_USD, "NOMO_MAX_POSITION_USD limit"),
    total: positive(process.env.NOMO_MAX_TOTAL_USD, "NOMO_MAX_TOTAL_USD limit"),
  };
}

export function brokerStatus(state: unknown): PendingOrderStatus {
  switch (state) {
    case "filled": return "filled";
    case "partially_filled": case "partially-filled": return "partially_filled";
    case "cancelled": case "canceled": case "voided": return "canceled";
    case "expired": case "rejected": case "failed": return "broker_rejected";
    case "queued": case "confirmed": case "pending": case "unconfirmed": case "open":
    case "placed": case "accepted": case "pending_cancel": case "submitted": return "submitted";
    default: return "uncertain";
  }
}

export function quoteMap(raw: unknown): Map<string, number> {
  const data = brokerData(raw);
  const prices = new Map<string, number>();
  for (const item of rows(data, data.results ? "results" : "quotes")) {
    const q = fields(item.quote ?? item);
    prices.set(String(q.symbol), positive(q.last_trade_price, "broker quote"));
  }
  return prices;
}

export function checkExposure(
  order: PendingOrderView, holdings: Fields[], orders: Fields[], prices: Map<string, number>,
  limits: ReturnType<typeof dollarLimits>,
): void {
  const exposure = new Map<string, number>();
  let heldShares = 0;
  const add = (symbol: string, dollars: number) => exposure.set(symbol, (exposure.get(symbol) ?? 0) + dollars);
  for (const p of holdings) {
    if (typeof p.symbol !== "string" || !p.symbol || (p.side && p.side !== "long")) {
      throw new Error("Unsupported equity position. Exposure cannot be verified.");
    }
    const qty = number(p.quantity, "held shares");
    const value = p.market_value == null ? qty * positive(prices.get(p.symbol), "position quote") : number(p.market_value, "market value");
    if (qty > 0 && value === 0) throw new Error("Missing equity valuation.");
    add(p.symbol, value);
    if (p.symbol === order.ticker) heldShares += qty;
  }
  for (const pending of orders) {
    const state = brokerStatus(pending.state);
    if (state === "filled" || state === "canceled" || state === "broker_rejected") continue;
    if (state === "uncertain" || typeof pending.symbol !== "string") throw new Error("Unknown open order exposure.");
    if (pending.side === "sell") {
      if (pending.symbol === order.ticker && order.side === "sell") throw new Error("An open sell already reserves these shares.");
      continue;
    }
    if (pending.side !== "buy") throw new Error("Unknown broker order side.");
    const amount = pending.dollar_amount ?? (pending.dollar_based_amount as Fields | null)?.amount;
    // Reserve the full order through partial fills. This can overestimate exposure.
    const cost = amount != null ? positive(amount, "open buy amount") :
      positive(pending.quantity, "open buy quantity") * positive(pending.limit_price, "open buy price bound");
    add(pending.symbol, cost);
  }
  let notional: number;
  if (order.dollarAmount !== null) {
    notional = positive(order.dollarAmount, "order amount");
  } else {
    const qty = positive(order.quantity, "quantity");
    // A market or stop-market share buy has no maximum execution price.
    const price = order.side === "buy" ? positive(order.limitPrice, "buy limit price (or use a dollar amount)") :
      Math.max(positive(prices.get(order.ticker), "sell quote"), number(order.limitPrice ?? 0, "limit price"));
    notional = qty * price;
  }
  if (!(Math.ceil(notional * 100) <= Math.floor(limits.order * 100))) throw new Error("Order exceeds the per-order limit.");
  if (order.side === "sell") {
    const exceedsHolding = order.quantity !== null ? Number(order.quantity) > heldShares :
      notional > heldShares * positive(prices.get(order.ticker), "sell quote");
    if (exceedsHolding) throw new Error("Sell exceeds broker-reported holdings.");
    return;
  }
  add(order.ticker, notional);
  const total = [...exposure.values()].reduce((sum, n) => sum + n, 0);
  if (exposure.get(order.ticker)! > limits.position || total > limits.total) {
    throw new Error("Buy exceeds the position or total equity exposure limit.");
  }
}
