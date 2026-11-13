/**
 * Phase 2 shadow hedger. It decides what it would trade and records simulated taker fills against the live
 * venue quotes, but never sends an order. Policy: when a series' worst-case loss passes the limit, move the
 * positions toward the book's target (net calls per strike, using OTM options plus the perp for put legs) by
 * whichever fraction minimizes worst-case loss + what the trade gives up (spread crossed + fees). A hedge has to
 * cut the worst case by more than it costs. Covering narrow ranges takes a condor much wider than the bet, so
 * often the best fraction is zero and the house carries the risk, earning the fee for it.
 */
import { config } from '../config.ts';
import { type BetRow, q, tx, usd } from '../db.ts';
import { type ShadowRow, bookFor, seriesBets, seriesPositions, targetCalls, unitPayoff } from './book.ts';
import { type LiveSeries, liveSeries } from './chains.ts';
import { BASE_FEE, PERP_FEE, type OptType, feePerContract, instrumentName, otmType, perpName, quoteAt } from './exec.ts';
import type { Chain } from './venues.ts';

const lastHedge = new Map<string, number>();
const MIN_GAP_MS = 60_000;

const roundTo = (x: number, step: number) => Math.round(x / step) * step;

interface Trade { instrument: string; type: OptType | 'PERP'; k: number; qty: number; price: number; mark: number; fee: number }

/** Trades that move the series' positions to target. Legs below the venue minimum or without a quote are skipped. */
function plan(s: LiveSeries, positions: ShadowRow[], target: Map<number, number>): { trades: Trade[]; skipped: string[] } {
  const ch: Chain = s.chain;
  const held = new Map<number, { C: number; P: number }>();
  let perp = 0;
  for (const p of positions) {
    if (p.type === 'PERP') { perp += p.qty; continue; }
    const h = held.get(p.strike) ?? { C: 0, P: 0 };
    h[p.type] += p.qty;
    held.set(p.strike, h);
  }

  const trades: Trade[] = [], skipped: string[] = [];
  let putsAfter = [...held.values()].reduce((a, h) => a + h.P, 0);
  for (const k of new Set([...target.keys(), ...held.keys()])) {
    const h = held.get(k) ?? { C: 0, P: 0 };
    // Keep trading whichever instrument we already hold at this strike, so a moving forward doesn't cause churn.
    const type: OptType = h.C !== 0 ? 'C' : h.P !== 0 ? 'P' : otmType(ch, k);
    const want = target.get(k) ?? 0;
    const qty = roundTo(want - h.C - h.P, ch.amountStep);
    if (Math.abs(qty) < ch.minAmount) {
      if (Math.abs(want - h.C - h.P) > 1e-9) skipped.push(`${k}: ${(want - h.C - h.P).toFixed(4)} below min ${ch.minAmount}`);
      continue;
    }
    const qt = quoteAt(ch, k, type);
    const price = qt ? (qty > 0 ? qt.ask : qt.bid) : 0;
    if (!qt || !(price > 0)) {
      skipped.push(`${k}${type}: no ${qty > 0 ? 'ask' : 'bid'}`);
      continue;
    }
    trades.push({
      instrument: instrumentName(s.sym, s.expiry, k, type), type, k, qty, price, mark: qt.mark,
      fee: Math.abs(qty) * feePerContract(ch, qt.mark) + BASE_FEE[s.venue],
    });
    if (type === 'P') putsAfter += qty;
  }
  // A put plus one unit of the underlying pays like a call, so the perp position always equals total puts held.
  const perpQty = roundTo(putsAfter - perp, ch.amountStep);
  if (Math.abs(perpQty) >= ch.minAmount) {
    trades.push({ instrument: perpName(s.sym), type: 'PERP', k: 0, qty: perpQty, price: ch.fwd, mark: ch.fwd, fee: Math.abs(perpQty) * ch.fwd * PERP_FEE });
  }
  return { trades, skipped };
}

/** Fractions of the way to target the hedger considers. */
const STEPS = [0, 0.25, 0.5, 0.75, 1];

/** Worst-case loss of the series if `trades` were added to its current book. */
function worstAfter(book: ReturnType<typeof bookFor>, trades: Trade[]): number {
  let cash = book.cash;
  for (const t of trades) cash -= t.qty * t.price + t.fee;
  let w = -Infinity;
  book.grid.forEach((sx, i) => {
    const h = book.hedge[i] + trades.reduce((a, t) => a + t.qty * unitPayoff(t.type, t.k, sx), 0);
    w = Math.max(w, book.liab[i] - h);
  });
  return w - cash;
}

function hedgeSeries(s: LiveSeries, now: number, book: ReturnType<typeof bookFor>) {
  const positions = seriesPositions(s.venue, s.sym, s.expiry);
  const target = targetCalls(seriesBets(s.sym, s.expiry));
  const held = new Map<number, number>();
  for (const p of positions) if (p.type !== 'PERP') held.set(p.strike, (held.get(p.strike) ?? 0) + p.qty);

  let best = { f: 0, worst: book.worstHedged, cost: 0, trades: [] as Trade[], skipped: [] as string[] };
  for (const f of STEPS.slice(1)) {
    const partial = new Map<number, number>();
    for (const k of new Set([...target.keys(), ...held.keys()])) {
      const h = held.get(k) ?? 0;
      partial.set(k, h + f * ((target.get(k) ?? 0) - h));
    }
    const { trades, skipped } = plan(s, positions, partial);
    const worst = worstAfter(book, trades);
    const cost = trades.reduce((a, t) => a + (t.price - t.mark) * t.qty + t.fee, 0);
    if (trades.length && worst + cost < best.worst + best.cost - 1) best = { f, worst, cost, trades, skipped };
  }
  const why = `worst-case loss ${book.worstHedged.toFixed(0)} > limit ${config.riskLimit}`;
  if (!best.trades.length) {
    console.log(`[hedger] ${s.sym} ${new Date(s.expiry).toISOString().slice(0, 16)}: ${why}, but no hedge cuts it by more than it costs; carrying the risk`);
    return;
  }
  const reason = `${why}; hedged ${best.f * 100}% of the way to target → ${best.worst.toFixed(0)} for ${best.cost.toFixed(0)} in spread + fees`;
  tx(() => {
    for (const t of best.trades) {
      q.upsertShadow.run(s.venue, s.sym, s.expiry, t.instrument, t.type, t.k, t.qty, t.qty * t.price);
      q.insertFill.run(now, s.venue, s.sym, s.expiry, t.instrument, t.qty, t.price, t.mark, t.fee, reason);
    }
  });
  console.log(`[hedger] ${s.sym} ${new Date(s.expiry).toISOString().slice(0, 16)}: ${best.trades.length} shadow fill(s) (${reason})${best.skipped.length ? `, skipped ${best.skipped.join('; ')}` : ''}`);
}

export function hedgeOnce(now = Date.now()) {
  for (const s of liveSeries(now)) {
    if (!s.open) continue;
    const key = `${s.sym}:${s.expiry}`;
    if (now - (lastHedge.get(key) ?? 0) < MIN_GAP_MS) continue;
    const book = bookFor(s.venue, s.sym, s.expiry, s.curve);
    if (book.worstHedged <= config.riskLimit) continue;
    lastHedge.set(key, now);
    hedgeSeries(s, now, book);
  }
}

export function startHedger() {
  setInterval(() => {
    try { hedgeOnce(); } catch (e) { console.error('[hedger]', e); }
  }, config.hedgeEveryMs).unref();
}

/**
 * Called once a series has settled: books what the hedge paid against what the bets paid, then clears the
 * positions. Runs inside the settlement transaction.
 */
export function settleShadow(venue: LiveSeries['venue'], sym: string, expiry: number, price: number, now: number) {
  const positions = seriesPositions(venue, sym, expiry);
  const all = q.optSeriesBets.all(sym, expiry) as unknown as BetRow[];
  const { fee } = q.seriesFees.get(venue, sym, expiry) as { fee: number };
  q.insertResult.run(
    venue, sym, expiry, price, all.length,
    all.reduce((a, b) => a + usd(b.stake), 0),
    all.reduce((a, b) => a + usd(b.returned ?? 0), 0),
    positions.reduce((a, p) => a + p.qty * unitPayoff(p.type, p.strike, price), 0),
    positions.reduce((a, p) => a + p.cost, 0),
    fee, now,
  );
  q.clearShadow.run(venue, sym, expiry);
}
