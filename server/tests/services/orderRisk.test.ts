import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingOrderView } from "@nomo/shared";
import { brokerStatus, checkExposure, quoteMap, rows } from "../../src/services/orderRisk.js";

const buy = {ticker: "AAA", side: "buy", quantity: "2", limitPrice: "10", dollarAmount: null} as PendingOrderView;
const limits = {order: 30, position: 50, total: 60};

test("risk requires complete pages and finite valuations", () => {
  assert.throws(() => rows({data: {positions: [], next: "page2"}}, "positions"));
  assert.throws(() => rows({data: {}}, "orders"));
  const prices = quoteMap({data: {results: [{quote: {symbol: "AAA", last_trade_price: "12"}}]}});
  checkExposure(buy, [{symbol: "AAA", quantity: "2"}], [], prices, limits);
  assert.throws(() => checkExposure(buy, [{symbol: "BBB", quantity: "1"}], [], prices, limits));
  assert.throws(() => checkExposure(buy, [{symbol: "BBB", quantity: "1", market_value: "NaN"}], [], prices, limits));
});

test("caps apply to the order, ticker, and combined equity exposure", () => {
  for (const cap of ["order", "position", "total"]) {
    assert.throws(() => checkExposure(buy, [], [], new Map(), {...limits, [cap]: 19}));
  }
  assert.throws(() => checkExposure({...buy, limitPrice: null}, [], [], new Map(), limits));
  const sell = {...buy, side: "sell" as const};
  assert.throws(() => checkExposure(sell, [], [], new Map([["AAA", 10]]), limits));
});

test("acknowledgments and partial fills are distinct from completed fills", () => {
  assert.equal(brokerStatus("confirmed"), "submitted");
  assert.equal(brokerStatus("partially_filled"), "partially_filled");
  assert.equal(brokerStatus("filled"), "filled");
  assert.equal(brokerStatus("cancelled"), "canceled");
  assert.equal(brokerStatus("unexpected"), "uncertain");
});
