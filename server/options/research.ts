/**
 * Phase 0: measure what hedging ranges would really cost. Every config.sampleMs, for each fresh chain on both
 * venues, price a fixed set of range shapes at marks and as a taker (buy the condor, sell the condor) and store it.
 */
import { nearestStrike, rangeShape } from '../../shared/options.ts';
import type { Venue } from '../../shared/types.ts';
import { config } from '../config.ts';
import { q } from '../db.ts';
import { chains, curveOf, isFresh } from './chains.ts';
import { legsCost } from './exec.ts';

const YEAR_MS = 365 * 24 * 3_600_000;

/** Range shapes in units of the expected move σ (forward × ATM IV × √T): [label, center offset, half-width]. */
const SHAPES: [string, number, number][] = [
  ['ATM ±0.25σ', 0, 0.25],
  ['ATM ±0.5σ', 0, 0.5],
  ['ATM ±1σ', 0, 1],
  ['ATM ±1.5σ', 0, 1.5],
  ['+1σ ±0.5σ', 1, 0.5],
  ['−1σ ±0.5σ', -1, 0.5],
];

export function sampleOnce(now = Date.now()) {
  let n = 0;
  for (const ch of chains.values()) {
    if (!isFresh(ch, now) || ch.expiry <= now) continue;
    const curve = curveOf(ch);
    if (!curve || !(curve.atmIv > 0)) continue;
    const sd = curve.fwd * curve.atmIv * Math.sqrt((ch.expiry - now) / YEAR_MS);
    const seen = new Set<string>();
    for (const [label, center, half] of SHAPES) {
      const c = curve.fwd + center * sd;
      const lo = nearestStrike(curve.strikes, c - half * sd);
      let hi = nearestStrike(curve.strikes, c + half * sd);
      if (hi <= lo) hi = curve.strikes[curve.strikes.indexOf(lo) + 1] ?? lo;
      const shape = rangeShape(curve.strikes, lo, hi);
      if (!shape || seen.has(`${lo}:${hi}`)) continue;
      seen.add(`${lo}:${hi}`);
      const buy = legsCost(ch, shape.legs);
      const sell = legsCost(ch, shape.legs.map(l => ({ k: l.k, q: -l.q })));
      // A condor per $1 of payout is worth between 0 and 1; anything else means a bad quote somewhere.
      if (!Number.isFinite(buy.mark) || buy.mark <= 0 || buy.mark > 1) continue;
      q.insertSample.run(now, ch.venue, ch.sym, ch.expiry, ch.quoteKind, label, lo, hi, buy.mark,
        buy.exec, sell.exec === null ? null : -sell.exec, buy.fee);
      n++;
    }
  }
  return n;
}

export function startResearch() {
  const tick = () => {
    try { sampleOnce(); } catch (e) { console.error('[research]', e); }
  };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, config.sampleMs).unref();
  setInterval(() => q.pruneSamples.run(Date.now() - config.sampleKeepDays * 86_400_000), 3_600_000).unref();
}

/* ---------- summary ---------- */

export interface SpreadRow {
  venue: Venue;
  sym: string;
  tenor: string;
  shape: string;
  quoteKind: string;
  n: number;
  /** Share of samples where every leg had the quote it needed. */
  executable: number;
  /** Median value at marks, per $1 of payout. */
  mark: number;
  /** Median extra cost of buying the condor as a taker, relative to its mark value. */
  buyMarkup: number | null;
  /** Median shortfall when selling the condor as a taker, relative to its mark value. */
  sellMarkup: number | null;
  /** Median per-contract fees relative to the mark value. */
  fee: number;
}

const TENORS: [string, number][] = [['< 1d', 1], ['1–3d', 3], ['3–7d', 7], ['7–14d', 14], ['14–30d', 31]];
const tenorOf = (days: number) => TENORS.find(([, d]) => days < d)?.[0] ?? '> 30d';

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface SampleRow { t: number; venue: Venue; sym: string; expiry: number; quote_kind: string; shape: string; mark: number; buy: number | null; sell: number | null; fee: number }

export function spreadSummary(sinceMs: number): SpreadRow[] {
  const groups = new Map<string, SampleRow[]>();
  for (const r of q.samplesSince.all(sinceMs) as unknown as SampleRow[]) {
    const key = [r.venue, r.sym, tenorOf((r.expiry - r.t) / 86_400_000), r.shape, r.quote_kind].join('|');
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const shapeOrder = SHAPES.map(s => s[0]);
  return [...groups.entries()].map(([key, rows]) => {
    const [venue, sym, tenor, shape, quoteKind] = key.split('|');
    const buys = rows.filter(r => r.buy != null).map(r => (r.buy! - r.mark) / r.mark);
    const sells = rows.filter(r => r.sell != null).map(r => (r.mark - r.sell!) / r.mark);
    return {
      venue: venue as Venue, sym, tenor, shape, quoteKind, n: rows.length,
      executable: rows.filter(r => r.buy != null && r.sell != null).length / rows.length,
      mark: median(rows.map(r => r.mark))!,
      buyMarkup: median(buys), sellMarkup: median(sells),
      fee: median(rows.map(r => r.fee / r.mark))!,
    };
  }).sort((a, b) =>
    a.venue.localeCompare(b.venue) || a.sym.localeCompare(b.sym)
    || TENORS.findIndex(t => t[0] === a.tenor) - TENORS.findIndex(t => t[0] === b.tenor)
    || shapeOrder.indexOf(a.shape) - shapeOrder.indexOf(b.shape));
}
