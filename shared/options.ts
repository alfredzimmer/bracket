/**
 * Option-backed ranges. A range bet on an options-backed expiry pays like a call condor:
 * 100% inside [lo, hi], fading linearly to 0 across one strike step outside each edge
 * (lo − wl … lo and hi … hi + wh). That payoff is an exact sum of listed calls, so the
 * house book is just "net calls held per strike" and every number below is exact.
 */
import { FEE, MAX_PROB, MIN_PROB } from './pricing.ts';
import type { OptBook, OptCurve, Side } from './types.ts';

/** Call quantity per strike, per $1 of payout. */
export interface Leg { k: number; q: number }

export interface RangeShape { lo: number; hi: number; wl: number; wh: number; legs: Leg[] }

const idx = (strikes: number[], k: number) => strikes.findIndex(s => Math.abs(s - k) <= 1e-9 * Math.max(1, k));

/** Builds the condor for [lo, hi]. Both edges must be listed strikes with a strike beyond each. */
export function rangeShape(strikes: number[], lo: number, hi: number): RangeShape | null {
  const i = idx(strikes, lo), j = idx(strikes, hi);
  if (i < 1 || j < 0 || j >= strikes.length - 1 || j <= i) return null;
  const wl = strikes[i] - strikes[i - 1], wh = strikes[j + 1] - strikes[j];
  return {
    lo, hi, wl, wh,
    legs: [
      { k: strikes[i - 1], q: 1 / wl }, { k: lo, q: -1 / wl },
      { k: hi, q: -1 / wh }, { k: strikes[j + 1], q: 1 / wh },
    ],
  };
}

/** Fraction of the payout an "in" bet returns at settlement price `s`. */
export function inFraction(lo: number, hi: number, wl: number, wh: number, s: number): number {
  if (s >= lo && s <= hi) return 1;
  // Hard-edged ranges (wl = wh = 0) pay nothing outside.
  if (s < lo ? wl <= 0 : wh <= 0) return 0;
  if (s < lo) return Math.max(0, 1 - (lo - s) / wl);
  return Math.max(0, 1 - (s - hi) / wh);
}

export const sideFraction = (side: Side, lo: number, hi: number, wl: number, wh: number, s: number) =>
  side === 'in' ? inFraction(lo, hi, wl, wh, s) : 1 - inFraction(lo, hi, wl, wh, s);

/** Call mark at a listed strike. */
export function callAt(c: OptCurve, k: number): number {
  const i = idx(c.strikes, k);
  if (i < 0) throw new Error(`Strike ${k} is not listed.`);
  return c.call[i];
}

/** Market value of $1 of payout on side `side`. For "in", the condor; for "out", 1 minus it (no discounting). */
export function rangeValue(c: OptCurve, shape: RangeShape, side: Side): number {
  const v = shape.legs.reduce((a, l) => a + l.q * callAt(c, l.k), 0);
  const vin = Math.min(1, Math.max(0, v));
  return side === 'in' ? vin : 1 - vin;
}

/* ---------- house book: liability at every settlement price that matters ---------- */

/**
 * Settlement prices where the house liability can be largest. Liabilities are piecewise linear with kinks only
 * at listed strikes, so checking every strike plus one point beyond each end finds the exact max.
 */
export function bookGrid(strikes: number[]): number[] {
  const lo = strikes[0], hi = strikes.at(-1)!;
  return [lo / 2, ...strikes, hi * 1.5];
}

/** Liability vector for one bet on `grid`. */
export function betLiability(grid: number[], side: Side, lo: number, hi: number, wl: number, wh: number, payout: number): number[] {
  return grid.map(s => payout * sideFraction(side, lo, hi, wl, wh, s));
}

/**
 * Worst-case house loss at settlement: max over the grid of (liability − hedge payoff), less the cash the series holds
 * (stakes collected minus hedge premiums and fees paid). Positive means the house can lose that much on this expiry.
 */
export function worstLoss(b: Pick<OptBook, 'liab' | 'hedge' | 'cash'>, extraLiab?: number[], extraCash = 0): number {
  let w = -Infinity;
  for (let i = 0; i < b.liab.length; i++) w = Math.max(w, b.liab[i] + (extraLiab?.[i] ?? 0) - b.hedge[i]);
  return w - b.cash - extraCash;
}

/* ---------- inventory skew ---------- */

/**
 * Skew per unit of worst-case loss a bet adds (as a fraction of the series limit), at an empty book. It grows with how
 * much of the limit is already used, so the tenth bet on the same side pays clearly less than the first.
 */
export const SKEW_PER_LIMIT = 0.03;
/** Most a risky bet's multiplier is cut. */
export const SKEW_MAX = 0.1;
/** Most a risk-reducing bet's multiplier is improved (half the practice fee). */
export const SKEW_BONUS_MAX = FEE / 2;

/**
 * Multiplier factor for a bet that moves the house's worst-case loss from `before` to `after`. The charge is the added
 * risk times (1 + how much of the limit is used before and after), so it rises as the book gets lopsided, and a bet
 * that offsets a heavily loaded book earns a bigger bonus.
 */
export function skewFactor(before: number, after: number, limit: number): number {
  const L = Math.max(limit, 1);
  const used = (w: number) => Math.max(0, w) / L;
  const raw = SKEW_PER_LIMIT * ((after - before) / L) * (1 + used(before) + used(after));
  return 1 - Math.min(SKEW_MAX, Math.max(-SKEW_BONUS_MAX, raw));
}

/* ---------- what the hedge really costs ---------- */

/**
 * Cost of trading `legs` as a taker, per $1 of payout: buy at the ask, sell at the bid, plus the venue fee on every
 * contract. Positive means the house pays. Null when a leg has no quote on the side it needs.
 */
export function tradeCost(c: OptCurve, legs: Leg[]): number | null {
  let cost = 0;
  for (const { k, q } of legs) {
    const i = idx(c.strikes, k);
    if (i < 0) return null;
    const px = q > 0 ? c.ask[i] : c.bid[i];
    if (!(px > 0)) return null;
    cost += q * px + Math.abs(q) * c.fee[i];
  }
  return cost;
}

const flip = (legs: Leg[]) => legs.map(l => ({ k: l.k, q: -l.q }));

/**
 * What it costs the house to hedge $1 of payout on `side` the moment it takes the bet. An "in" bet is hedged by buying
 * the condor; an "out" bet pays 1 − condor, so it's hedged by selling the condor and holding $1.
 */
export function hedgePrice(c: OptCurve, shape: RangeShape, side: Side): number | null {
  const cost = side === 'in' ? tradeCost(c, shape.legs) : tradeCost(c, flip(shape.legs));
  return cost === null ? null : Math.min(1, Math.max(0, (side === 'in' ? 0 : 1) + cost));
}

/** What unwinding that hedge returns per $1 of payout (sell the condor back for "in", buy it back for "out"). */
export function unwindValue(c: OptCurve, shape: RangeShape, side: Side): number | null {
  const cost = side === 'in' ? tradeCost(c, flip(shape.legs)) : tradeCost(c, shape.legs);
  return cost === null ? null : Math.min(1, Math.max(0, (side === 'in' ? 0 : 1) - cost));
}

/* ---------- quote ---------- */

export interface OptQuoteInput { curve: OptCurve; book?: OptBook; side: Side; lo: number; hi: number; stake: number }
export type OptQuote =
  | {
    ok: true;
    /** Price per $1 of payout the user is charged before the house fee: the hedge price. */
    prob: number;
    mult: number;
    /** Mid-market value per $1 of payout. */
    mid: number;
    /** Hedge price − mid: crossing the spread plus venue fees. */
    hedgeCost: number;
    skew: number;
    shape: RangeShape;
  }
  | { ok: false; prob: number; reason: string };

/**
 * Quotes a range at what it costs to hedge, then charges the house fee on top:
 * multiplier = (1 − FEE) / hedgePrice × inventory skew.
 */
export function optQuote({ curve, book, side, lo, hi, stake }: OptQuoteInput): OptQuote {
  const shape = rangeShape(curve.strikes, lo, hi);
  if (!shape) return { ok: false, prob: 0, reason: 'Range edges must be listed strikes, with at least one strike beyond each edge.' };
  const mid = rangeValue(curve, shape, side);
  const price = hedgePrice(curve, shape, side);
  if (price === null) {
    return { ok: false, prob: mid, reason: `${curve.venue === 'derive' ? 'Derive' : 'The venue'} has no ${side === 'in' ? 'ask' : 'bid'} on one of this range's strikes, so it can't be hedged. Move or widen it.` };
  }
  if (price < MIN_PROB) {
    return { ok: false, prob: price, reason: side === 'in'
      ? 'This range costs under 1% to hedge. Widen it or move it closer to the forward.'
      : 'This range covers almost every outcome. Narrow it to bet outside.' };
  }
  if (price > MAX_PROB) {
    return { ok: false, prob: price, reason: side === 'in'
      ? 'Hedging this range costs over 95% of its payout, so it would pay under 1.02×. Narrow it.'
      : 'Settling outside this range is almost certain once hedging costs are counted. Widen the range or move it closer to the forward.' };
  }
  const base = (1 - FEE) / price;
  let skew = 1;
  if (book && book.grid.length) {
    const payout = Math.max(stake, 0) * base;
    const extra = betLiability(book.grid, side, lo, hi, shape.wl, shape.wh, payout);
    skew = skewFactor(worstLoss(book), worstLoss(book, extra, stake), book.limit);
  }
  return { ok: true, prob: price, mult: base * skew, mid, hedgeCost: price - mid, skew, shape };
}

/** Early-close value: what unwinding the bet's hedge returns, less the house fee. Null when it can't be unwound. */
export function optMarkValue(c: OptCurve, side: Side, lo: number, hi: number, payout: number): number | null {
  const shape = rangeShape(c.strikes, lo, hi);
  const v = shape && unwindValue(c, shape, side);
  return v == null ? null : payout * v * (1 - FEE);
}

/* ---------- market-implied distribution ---------- */

/**
 * Risk-neutral density implied by call prices: the second difference of C(K), i.e. a butterfly's price
 * divided by its width squared. Returns one density value per interior strike.
 */
export function impliedDensity(c: OptCurve): { k: number; f: number }[] {
  const out: { k: number; f: number }[] = [];
  for (let i = 1; i < c.strikes.length - 1; i++) {
    const [k0, k1, k2] = [c.strikes[i - 1], c.strikes[i], c.strikes[i + 1]];
    const s1 = (c.call[i] - c.call[i - 1]) / (k1 - k0);
    const s2 = (c.call[i + 1] - c.call[i]) / (k2 - k1);
    out.push({ k: k1, f: Math.max(0, (s2 - s1) / ((k2 - k0) / 2)) });
  }
  return out;
}

/** Nearest listed strike to `v`. */
export function nearestStrike(strikes: number[], v: number): number {
  let best = strikes[0];
  for (const k of strikes) if (Math.abs(k - v) < Math.abs(best - v)) best = k;
  return best;
}

/** Strike `n` places away from `k` (clamped to the list). */
export function stepStrike(strikes: number[], k: number, n: number): number {
  const i = idx(strikes, nearestStrike(strikes, k));
  return strikes[Math.min(strikes.length - 1, Math.max(0, i + n))];
}

/** Series key used by the client and the bets table for an options-backed expiry. */
export const optSeriesKey = (expiry: number) => `opt:${expiry}`;
export const parseOptSeries = (key: string) => (key.startsWith('opt:') ? Number(key.slice(4)) : null);

/**
 * Market-implied chance of settling below a price, as a smooth monotone curve. At the midpoint between two strikes the
 * chance of finishing above is the call spread's price per unit width (−dC/dK); between those points the curve is a
 * monotone cubic (Fritsch–Carlson), so the implied density is smooth instead of a staircase. Flat beyond the ends.
 */
function impliedCdf(c: OptCurve): { at: (p: number) => number; slope: (p: number) => number } {
  const ks = c.strikes;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const above = Math.min(1, Math.max(0, (c.call[i] - c.call[i + 1]) / (ks[i + 1] - ks[i])));
    xs.push((ks[i] + ks[i + 1]) / 2);
    ys.push(Math.max(ys.at(-1) ?? 0, 1 - above));
  }
  const n = xs.length;
  if (n < 2) return { at: () => 0.5, slope: () => 0 };
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = xs.map((_, i) => {
    if (i === 0) return d[0];
    if (i === n - 1) return d[n - 2];
    if (d[i - 1] * d[i] <= 0) return 0;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  });
  const seg = (p: number) => {
    let i = 0;
    while (i < n - 2 && xs[i + 1] < p) i++;
    return i;
  };
  return {
    at: p => {
      if (p <= xs[0]) return ys[0];
      if (p >= xs[n - 1]) return ys[n - 1];
      const i = seg(p), t = (p - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
      return Math.min(1, Math.max(0, y));
    },
    slope: p => {
      if (p <= xs[0] || p >= xs[n - 1]) return 0;
      const i = seg(p), t = (p - xs[i]) / h[i], t2 = t * t;
      return Math.max(0, ((6 * t2 - 6 * t) / h[i]) * ys[i] + (3 * t2 - 4 * t + 1) * m[i] + ((-6 * t2 + 6 * t) / h[i]) * ys[i + 1] + (3 * t2 - 2 * t) * m[i + 1]);
    },
  };
}

/** Market-implied density at any price (the slope of the implied chance of settling below it). */
export const densityFn = (c: OptCurve): ((p: number) => number) => impliedCdf(c).slope;

/** Market-implied chance of settling below `p`. */
export const probBelowFn = (c: OptCurve): ((p: number) => number) => impliedCdf(c).at;

/* ======================================================================================================
 * Range product (hard edges, any range). The user sees one thing: "pays stake × multiplier if the price
 * settles inside [lo, hi]" (or outside). The house turns that into Derive options behind the scenes:
 *   inside  → covered by the condor on the listed strikes just outside the range (it pays at least as much
 *             as the bet at every price, so the house is never short);
 *   outside → covered by $1 cash minus the condor on the strikes just inside the range (or by cash alone
 *             when the range is too narrow to fit one).
 * Users are quoted off the market's fair value plus a flat fee, because the house nets bets against each other
 * and only hedges what's left over (see server/options/hedger.ts).
 * ====================================================================================================== */

/** House fee on range-product bets: covers the hedging the house does on net exposure. */
export const OPT_FEE = 0.06;

/** Four strikes of a condor: 0 below k1, rising to 1 at k2, flat to k3, falling to 0 at k4. k2 may equal k3. */
export type Condor = [number, number, number, number];

/** Call legs per $1 of payout for a condor (legs at the same strike merged). */
export function condorLegs([k1, k2, k3, k4]: Condor): Leg[] {
  const m = new Map<number, number>();
  const add = (k: number, q: number) => m.set(k, (m.get(k) ?? 0) + q);
  add(k1, 1 / (k2 - k1)); add(k2, -1 / (k2 - k1));
  add(k3, -1 / (k4 - k3)); add(k4, 1 / (k4 - k3));
  return [...m].filter(([, q]) => Math.abs(q) > 1e-15).map(([k, q]) => ({ k, q }));
}

/** Smallest condor on listed strikes that pays ≥ 1 everywhere in [lo, hi]. Null if the strikes don't reach. */
export function outerCondor(strikes: number[], lo: number, hi: number): Condor | null {
  const i = strikes.findLastIndex(k => k <= lo + 1e-9);
  const j = strikes.findIndex(k => k >= hi - 1e-9);
  if (i < 1 || j < 0 || j > strikes.length - 2 || hi <= lo) return null;
  return [strikes[i - 1], strikes[i], strikes[j], strikes[j + 1]];
}

/** Largest condor on listed strikes that pays ≤ 1 inside [lo, hi] and 0 outside it. Null if none fits. */
export function innerCondor(strikes: number[], lo: number, hi: number): Condor | null {
  const i = strikes.findIndex(k => k >= lo - 1e-9);
  const j = strikes.findLastIndex(k => k <= hi + 1e-9);
  if (i < 0 || j < 0 || j - i < 2) return null;
  return [strikes[i], strikes[i + 1], strikes[j - 1], strikes[j]];
}

/** The condor the house holds for a bet (+1 for inside, −1 for outside, which also holds $1 per $1 of payout). */
export function rangeHedge(strikes: number[], side: Side, lo: number, hi: number): Condor | null {
  return side === 'in' ? outerCondor(strikes, lo, hi) : innerCondor(strikes, lo, hi);
}

const condorMid = (c: OptCurve, k: Condor | null) =>
  k ? condorLegs(k).reduce((a, l) => a + l.q * callAt(c, l.k), 0) : 0;

/** True when [lo, hi] can be priced and covered on this curve. */
export const inRangeOfStrikes = (c: OptCurve, lo: number, hi: number) =>
  hi > lo && lo >= c.strikes[1] && hi <= c.strikes[c.strikes.length - 2];

/**
 * Market fair value of $1 paid if the price settles inside [lo, hi] (or outside): the implied chance of landing
 * there, kept between what the inner and outer condors are worth (so it can never disagree with the hedges).
 */
export function rangeFair(c: OptCurve, side: Side, lo: number, hi: number): number {
  const pb = probBelowFn(c);
  const floor = Math.max(0, condorMid(c, innerCondor(c.strikes, lo, hi)));
  const cap = Math.min(1, condorMid(c, outerCondor(c.strikes, lo, hi)) || 1);
  const pin = Math.min(cap, Math.max(floor, pb(hi) - pb(lo)));
  return side === 'in' ? pin : 1 - pin;
}

/** Cost per $1 of payout if the house hedged this one bet by itself, as a taker. Null when a leg has no quote. */
export function standaloneHedgeCost(c: OptCurve, side: Side, lo: number, hi: number): number | null {
  const k = rangeHedge(c.strikes, side, lo, hi);
  if (side === 'in') return k ? tradeCost(c, condorLegs(k)) : null;
  if (!k) return 1;
  const cost = tradeCost(c, condorLegs(k).map(l => ({ k: l.k, q: -l.q })));
  return cost === null ? null : 1 + cost;
}

export interface RangeQuoteInput { curve: OptCurve; book?: OptBook; side: Side; lo: number; hi: number; stake: number }
export type RangeQuote =
  | { ok: true; prob: number; mult: number; skew: number; fee: number; hedge: Condor | null; hedgeCost: number | null }
  | { ok: false; prob: number; reason: string };

/** Multiplier = (1 − OPT_FEE) ÷ fair value × inventory skew. */
export function rangeQuote({ curve, book, side, lo, hi, stake }: RangeQuoteInput): RangeQuote {
  if (!inRangeOfStrikes(curve, lo, hi)) {
    return { ok: false, prob: 0, reason: hi <= lo
      ? 'The upper bound must be above the lower bound.'
      : `Keep the range between ${curve.strikes[1].toLocaleString('en-US')} and ${curve.strikes.at(-2)!.toLocaleString('en-US')} for this expiry.` };
  }
  const prob = rangeFair(curve, side, lo, hi);
  if (prob < MIN_PROB) {
    return { ok: false, prob, reason: side === 'in'
      ? 'This range is under 1% likely. Widen it or move it closer to the price.'
      : 'This range covers almost every outcome. Narrow it to bet outside.' };
  }
  if (prob > MAX_PROB) {
    return { ok: false, prob, reason: side === 'in'
      ? 'This range is almost certain, so it would pay under 1.02×. Narrow it.'
      : 'Settling outside this range is almost certain. Widen the range or move it closer to the price.' };
  }
  const base = (1 - OPT_FEE) / prob;
  let skew = 1;
  if (book && book.grid.length) {
    const payout = Math.max(stake, 0) * base;
    const grid = [...new Set([...book.grid, ...edgePoints(lo, hi)])].sort((a, b) => a - b);
    const at = (arr: number[]) => grid.map(s => interpAt(book.grid, arr, s));
    const b2 = { liab: at(book.liab), hedge: at(book.hedge), cash: book.cash };
    const extra = betLiability(grid, side, lo, hi, 0, 0, payout);
    skew = skewFactor(worstLoss(b2), worstLoss(b2, extra, stake), book.limit);
  }
  return {
    ok: true, prob, mult: base * skew, skew, fee: OPT_FEE,
    hedge: rangeHedge(curve.strikes, side, lo, hi), hedgeCost: standaloneHedgeCost(curve, side, lo, hi),
  };
}

/** Early-close value: fair value of the remaining payout, less the fee. */
export const rangeMarkValue = (c: OptCurve, side: Side, lo: number, hi: number, payout: number) =>
  payout * rangeFair(c, side, lo, hi) * (1 - OPT_FEE);

/** Points just inside and outside a hard range edge, where a liability can jump. */
export function edgePoints(lo: number, hi: number): number[] {
  const e = (x: number) => Math.max(1e-9, Math.abs(x) * 1e-9);
  return [lo - e(lo), lo, hi, hi + e(hi)];
}

/**
 * A book vector at price s. Exact at grid points. Between them it's linear, which is exact for option payoffs and
 * conservative enough for skew (the server re-prices against its own exact grid anyway).
 */
function interpAt(grid: number[], v: number[], s: number): number {
  if (s <= grid[0]) return v[0];
  if (s >= grid.at(-1)!) return v.at(-1)!;
  let i = 1;
  while (grid[i] < s) i++;
  const t = (s - grid[i - 1]) / (grid[i] - grid[i - 1]);
  return v[i - 1] + t * (v[i] - v[i - 1]);
}
