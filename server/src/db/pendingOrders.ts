import { randomUUID } from "node:crypto";
import type { OrderAction, OrderSide, OrderType, PendingOrderStatus, PendingOrderView } from "@nomo/shared";
import { getDb } from "./index.js";

/**
 * Pending order storage for the confirmation gate. Status transitions are
 * single atomic UPDATEs guarded by the current status, so a double confirm
 * or a confirm after expiry can never slip through.
 */

import { getRobinhoodAccountNumber } from "./settings.js";

const EXPIRY_MS = 5 * 60 * 1000;

interface PendingOrderRow {
  id: string;
  action: OrderAction;
  ticker: string;
  side: OrderSide | null;
  quantity: string | null;
  dollar_amount: string | null;
  order_type: OrderType | null;
  limit_price: string | null;
  stop_price: string | null;
  broker_ref: string | null;
  broker_state: PendingOrderStatus | null;
  rationale: string;
  status: PendingOrderStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  result: string | null;
  reject_reason: string | null;
  thesis: string | null;
  bear_case: string | null;
  broker_warnings: string | null;
}

function toView(row: PendingOrderRow): PendingOrderView {
  return {
    id: row.id,
    action: row.action,
    ticker: row.ticker,
    side: row.side,
    quantity: row.quantity,
    dollarAmount: row.dollar_amount,
    orderType: row.order_type,
    limitPrice: row.limit_price,
    stopPrice: row.stop_price,
    brokerRef: row.broker_ref,
    rationale: row.rationale,
    status: row.broker_state ?? row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    result: row.result,
    rejectReason: row.reject_reason,
    thesis: row.thesis,
    bearCase: row.bear_case,
    brokerWarnings: row.broker_warnings,
  };
}

export interface NewPendingOrder {
  action: OrderAction;
  ticker: string;
  side: OrderSide | null;
  quantity: string | null;
  dollarAmount?: string | null;
  orderType: OrderType | null;
  limitPrice: string | null;
  stopPrice?: string | null;
  brokerRef: string | null;
  rationale: string;
  /** Research context for orchestrated proposals; omitted for direct orders. */
  thesis?: string | null;
  bearCase?: string | null;
  brokerWarnings?: string | null;
}

export function createPendingOrder(order: NewPendingOrder): PendingOrderView {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO pending_orders (id, action, ticker, side, quantity, dollar_amount, order_type, limit_price, stop_price, broker_ref, rationale, status, expires_at, thesis, bear_case, broker_warnings, selected_account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      order.action,
      order.ticker,
      order.side,
      order.quantity,
      order.dollarAmount ?? null,
      order.orderType,
      order.limitPrice,
      order.stopPrice ?? null,
      order.brokerRef,
      order.rationale,
      expiresAt,
      order.thesis ?? null,
      order.bearCase ?? null,
      order.brokerWarnings ?? null,
      getRobinhoodAccountNumber(),
    );
  return getPendingOrder(id)!;
}

export function getPendingOrder(id: string): PendingOrderView | null {
  const row = getDb().prepare("SELECT * FROM pending_orders WHERE id = ?").get(id) as
    | PendingOrderRow
    | undefined;
  return row ? toView(row) : null;
}

/** Sweeps stale awaiting orders; called before every gate action. */
export function expireStaleOrders(): void {
  getDb()
    .prepare(
      `UPDATE pending_orders
       SET status = 'expired', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'awaiting_confirmation' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run();
}

function transition(id: string, from: PendingOrderStatus, to: PendingOrderStatus, extra?: { requireUnexpired?: boolean; result?: string }): boolean {
  const guards = extra?.requireUnexpired
    ? "AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    : "";
  const changes = getDb()
    .prepare(
      `UPDATE pending_orders
       SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), result = COALESCE(?, result)
       WHERE id = ? AND status = ? ${guards}`,
    )
    .run(to, extra?.result ?? null, id, from).changes;
  return changes === 1;
}

export function confirmPendingOrder(id: string): boolean {
  // A stopped process can leave a preflight claim. Only expire claims which
  // never crossed beginSubmission; delayed preflights must claim again to send.
  getDb().prepare(`UPDATE pending_orders SET status='failed', result='Preflight timed out before submission'
    WHERE status='confirmed' AND broker_state IS NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run();
  return getDb().prepare(`UPDATE pending_orders SET status = 'confirmed' , resolved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'awaiting_confirmation' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND (action = 'cancel' OR NOT EXISTS (SELECT 1 FROM pending_orders WHERE status = 'confirmed'
      AND action = 'place' AND broker_state IS NULL))`).run(id).changes === 1;
}

export function rejectPendingOrder(id: string, reason?: string | null): boolean {
  const rejected = transition(id, "awaiting_confirmation", "rejected");
  if (rejected && reason) {
    getDb().prepare("UPDATE pending_orders SET reject_reason = ? WHERE id = ?").run(reason, id);
  }
  return rejected;
}

/** Confirmed and executed orders with the veto reasons on the rejected ones. */
export function listResolvedOrders(limit = 100): PendingOrderView[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pending_orders
       WHERE status IN ('executed', 'rejected', 'confirmed', 'failed')
       ORDER BY resolved_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(limit) as PendingOrderRow[];
  return rows.map(toView);
}

export function orderBinding(id: string) {
  return getDb().prepare("SELECT selected_account AS account, broker_order_id AS brokerId FROM pending_orders WHERE id = ?")
    .get(id) as { account: string | null; brokerId: string | null };
}

export function trackOrder(id: string, state: PendingOrderStatus, message?: string, brokerId?: string) {
  // Conditional updates prevent stale reads from reverting a terminal fill or a partial fill.
  getDb().prepare(`UPDATE pending_orders SET status = 'executed', broker_state = ?,
    result = COALESCE(?, result), broker_order_id = COALESCE(?, broker_order_id)
    WHERE id = ? AND status IN ('confirmed','executed')
    AND (broker_state IS NULL OR broker_state IN ('submitted','uncertain','partially_filled'))
    AND NOT (COALESCE(broker_state,'') = 'partially_filled' AND ? = 'submitted')`)
    .run(state, message ?? null, brokerId ?? null, id, state);
}

export function trackedOrders(account: string): PendingOrderView[] {
  const found = getDb().prepare(`SELECT * FROM pending_orders WHERE (selected_account = ? OR selected_account IS NULL)
    AND status IN ('confirmed','executed') AND (broker_state IS NULL OR broker_state IN ('submitted','uncertain','partially_filled'))`)
    .all(account) as PendingOrderRow[];
  return found.map(toView);
}

export function beginSubmission(id: string) {
  const claimed = getDb().prepare(`UPDATE pending_orders SET broker_state = 'uncertain'
    WHERE id = ? AND status = 'confirmed' AND broker_state IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(id);
  if (!claimed.changes) throw new Error("Order confirmation expired before submission.");
}

export function markOrderFailed(id: string, error: string): boolean {
  return getDb().prepare("UPDATE pending_orders SET status = 'failed', broker_state = NULL, result = ? WHERE id = ? AND status = 'confirmed'").run(error,id).changes === 1;
}
