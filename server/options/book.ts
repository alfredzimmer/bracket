/**
 * The house book for one options-backed series. Every open bet is a condor (or cash minus a condor), so the
 * book reduces to net calls per strike, and liability is exact at every settlement price.
 */
import { type Leg, betLiability, bookGrid, condorLegs, edgePoints, worstLoss } from '../../shared/options.ts';
import type { OptBook, OptCurve, Venue } from '../../shared/types.ts';
import { config } from '../config.ts';
import { type BetRow, q, usd } from '../db.ts';

export interface ShadowRow {
  venue: Venue; sym: string; expiry: number; instrument: string;
  type: 'C' | 'P' | 'PERP'; strike: number; qty: number; cost: number;
}

/**
 * Call legs per $1 of payout of the condor the house holds for a stored bet (its own strikes, even if the venue later
 * lists new ones). Hard-edged bets store the condor's strikes; early soft-edged bets are the condor itself.
 */
export function betLegs(b: Pick<BetRow, 'lo' | 'hi' | 'wl' | 'wh' | 'h1' | 'h2' | 'h3' | 'h4'>): Leg[] {
  if (b.wl <= 0) return b.h1 == null ? [] : condorLegs([b.h1, b.h2!, b.h3!, b.h4!]);
  return [
    { k: b.lo - b.wl, q: 1 / b.wl }, { k: b.lo, q: -1 / b.wl },
    { k: b.hi, q: -1 / b.wh }, { k: b.hi + b.wh, q: 1 / b.wh },
  ];
}

/** Calls the house must hold, per strike, to cover every open bet (in-bets: +condor, out-bets: −condor plus cash). */
export function targetCalls(bets: BetRow[]): Map<number, number> {
  const net = new Map<number, number>();
  for (const b of bets) {
    const sign = b.side === 'in' ? 1 : -1;
    for (const l of betLegs(b)) net.set(l.k, (net.get(l.k) ?? 0) + sign * usd(b.payout) * l.q);
  }
  return net;
}

/** What one unit of a hedge instrument is worth at settlement price s. Perps count at s; their entry is in cost. */
export function unitPayoff(type: ShadowRow['type'], k: number, s: number): number {
  return type === 'C' ? Math.max(0, s - k) : type === 'P' ? Math.max(0, k - s) : s;
}

export const seriesBets = (sym: string, expiry: number) =>
  (q.optOpenBets.all() as unknown as BetRow[]).filter(b => b.sym === sym && b.expires_at === expiry);

export const seriesPositions = (venue: Venue, sym: string, expiry: number) =>
  q.shadowPositions.all(venue, sym, expiry) as unknown as ShadowRow[];

export interface BookDetail extends OptBook {
  bets: BetRow[];
  positions: ShadowRow[];
  stakes: number;
  fees: number;
  /** Cost of crossing the spread so far: Σ (fill − mark) × qty. */
  slippage: number;
  worstHedged: number;
  worstUnhedged: number;
}

export function bookFor(venue: Venue, sym: string, expiry: number, curve: OptCurve): BookDetail {
  const bets = seriesBets(sym, expiry);
  const positions = seriesPositions(venue, sym, expiry);
  const ks = new Set(bookGrid(curve.strikes));
  for (const b of bets) {
    for (const l of betLegs(b)) ks.add(l.k);
    if (b.wl <= 0) for (const e of edgePoints(b.lo, b.hi)) ks.add(e);
  }
  for (const p of positions) if (p.type !== 'PERP') ks.add(p.strike);
  const grid = [...ks].sort((a, b) => a - b);

  const liab = grid.map(() => 0);
  for (const b of bets) {
    const v = betLiability(grid, b.side, b.lo, b.hi, b.wl, b.wh, usd(b.payout));
    for (let i = 0; i < grid.length; i++) liab[i] += v[i];
  }
  const hedge = grid.map(s => positions.reduce((a, p) => a + p.qty * unitPayoff(p.type, p.strike, s), 0));
  const stakes = bets.reduce((a, b) => a + usd(b.stake), 0);
  const { fee, slip } = q.seriesFees.get(venue, sym, expiry) as { fee: number; slip: number };
  const cash = stakes - positions.reduce((a, p) => a + p.cost, 0) - fee;
  const book: OptBook = { grid, liab, hedge, cash, limit: config.riskLimit };
  return {
    ...book, bets, positions, stakes, fees: fee, slippage: slip,
    worstHedged: worstLoss(book),
    worstUnhedged: worstLoss({ liab, hedge: grid.map(() => 0), cash: stakes }),
  };
}

/** The book as the client needs it for skew (no rows). */
export const publicBook = (d: BookDetail): OptBook => ({ grid: d.grid, liab: d.liab, hedge: d.hedge, cash: d.cash, limit: d.limit });
