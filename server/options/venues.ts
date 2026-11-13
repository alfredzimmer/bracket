/**
 * Read-only adapters for Derive and Hypercall public market data. No keys, no orders.
 * Each venue is reduced to the same Chain shape: one expiry, one row per strike, call and put quotes.
 */
import type { Venue } from '../../shared/types.ts';

export interface Quote {
  /** Best bid / ask in USD per contract, 0 when there is none. */
  bid: number;
  ask: number;
  mark: number;
  iv: number;
}

export interface ChainRow { k: number; c?: Quote; p?: Quote }

export interface Chain {
  venue: Venue;
  sym: string;
  /** Expiry, ms. */
  expiry: number;
  fwd: number;
  rows: ChainRow[];
  /** 'firm': resting order book. 'indicative': maker indications that can't be hit directly (Hypercall). */
  quoteKind: 'firm' | 'indicative';
  /** Smallest tradable size and size increment, in contracts. */
  minAmount: number;
  amountStep: number;
  updatedAt: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/* ---------- Derive ---------- */

const DERIVE = 'https://api.derive.xyz/v3';

async function derive(method: string, params: Record<string, unknown>): Promise<any> {
  const body = await getJson(`${DERIVE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (body.error) throw new Error(`Derive ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export interface DeriveExpiry { expiry: number; strikes: number[]; minAmount: number; amountStep: number }

/** Active option expiries for `sym`, with their listed strikes. */
export async function deriveExpiries(sym: string): Promise<DeriveExpiry[]> {
  const r = await derive('public/get_all_instruments', { instrument_type: 'option', currency: sym, expired: false, page_size: 1000 });
  const by = new Map<number, DeriveExpiry>();
  for (const i of r.instruments as any[]) {
    if (!i.is_active || !i.option_details) continue;
    const expiry = num(i.option_details.expiry) * 1000;
    const e = by.get(expiry) ?? { expiry, strikes: [], minAmount: num(i.minimum_amount), amountStep: num(i.amount_step) };
    e.strikes.push(num(i.option_details.strike));
    by.set(expiry, e);
  }
  for (const e of by.values()) e.strikes = [...new Set(e.strikes)].sort((a, b) => a - b);
  return [...by.values()].sort((a, b) => a.expiry - b.expiry);
}

const yyyymmdd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

export async function deriveChain(sym: string, e: DeriveExpiry): Promise<Chain> {
  const r = await derive('public/get_tickers', { instrument_type: 'option', currency: sym, expiry_date: yyyymmdd(e.expiry) });
  const rows = new Map<number, ChainRow>();
  let fwd = 0;
  for (const [name, t] of Object.entries(r.tickers as Record<string, any>)) {
    const [, , kStr, cp] = name.split('-');
    const k = num(kStr.replace('_', '.'));
    const op = t.option_pricing ?? {};
    if (!fwd && num(op.f) > 0) fwd = num(op.f);
    const qt: Quote = { bid: num(t.b), ask: num(t.a), mark: num(t.M), iv: num(op.i) };
    const row = rows.get(k) ?? { k };
    if (cp === 'C') row.c = qt; else row.p = qt;
    rows.set(k, row);
  }
  return {
    venue: 'derive', sym, expiry: e.expiry, fwd, quoteKind: 'firm',
    rows: [...rows.values()].sort((a, b) => a.k - b.k),
    minAmount: e.minAmount, amountStep: e.amountStep, updatedAt: Date.now(),
  };
}

/** Settlement prices Derive has published for `sym`, keyed by expiry (ms). */
export async function deriveSettlements(sym: string): Promise<Map<number, number>> {
  const r = await derive('public/get_option_settlement_prices', { currency: sym });
  return new Map((r.expiries as any[]).map(x => [num(x.utc_expiry_sec) * 1000, num(x.price)]));
}

/* ---------- Hypercall ---------- */

const HYPERCALL = 'https://api.hypercall.xyz';

/**
 * Every listed expiry for `sym`. Hypercall's order book is usually empty, so bid/ask fall back to the makers'
 * indicative quotes, and the chain is marked 'indicative'.
 */
export async function hypercallChains(sym: string): Promise<Chain[]> {
  const body = await getJson(`${HYPERCALL}/options-summary?currency=${encodeURIComponent(sym)}`);
  const by = new Map<number, Chain & { firm: boolean; rowMap: Map<number, ChainRow> }>();
  for (const t of body.result as any[]) {
    const [, , kStr, cp] = String(t.instrument_name).split('-');
    const expiry = num(t.expiration_timestamp);
    const ch = by.get(expiry) ?? {
      venue: 'hypercall' as const, sym, expiry, fwd: num(t.underlying_price), rows: [], quoteKind: 'indicative' as const,
      minAmount: 1e-6, amountStep: 1e-6, updatedAt: Date.now(), firm: false, rowMap: new Map<number, ChainRow>(),
    };
    const firm = num(t.bid_price) > 0 && num(t.ask_price) > 0;
    if (firm) ch.firm = true;
    const bid = firm ? num(t.bid_price) : num(t.indicative_bid_price);
    const ask = firm ? num(t.ask_price) : num(t.indicative_ask_price);
    // mark_price can be a stale last trade far outside the quotes, so use the quote mid, else Hypercall's model price.
    const qt: Quote = { bid, ask, mark: bid > 0 && ask > 0 ? (bid + ask) / 2 : num(t.theoretical_price), iv: num(t.mark_iv) };
    const k = num(kStr);
    const row = ch.rowMap.get(k) ?? { k };
    if (cp === 'C') row.c = qt; else row.p = qt;
    ch.rowMap.set(k, row);
    by.set(expiry, ch);
  }
  return [...by.values()].map(({ firm, rowMap, ...ch }) => ({
    ...ch,
    quoteKind: firm ? 'firm' : 'indicative',
    rows: [...rowMap.values()].sort((a, b) => a.k - b.k),
  }));
}
