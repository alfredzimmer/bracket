import type { Side } from './types.ts';

/** Pool fee taken out of every fair payout. */
export const FEE = 0.03;
/** Below this win chance a range is too unlikely to price. */
export const MIN_PROB = 0.01;
/** Above this win chance the payout would be under ~1.02x. */
export const MAX_PROB = 0.95;

const YEAR_MS = 365 * 24 * 3_600_000;

function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Standard deviation of log-price over the time left. */
export function sigma(vol: number, msLeft: number): number {
  return vol * Math.sqrt(Math.max(msLeft, 1000) / YEAR_MS);
}

/** P(settlement price < K) under a driftless lognormal model. */
export function probBelow(spot: number, k: number, s: number): number {
  if (k <= 0) return 0;
  return normCdf((Math.log(k / spot) + 0.5 * s * s) / s);
}

export function probInside(spot: number, lo: number, hi: number, s: number): number {
  return Math.max(0, probBelow(spot, hi, s) - probBelow(spot, lo, s));
}

export function winProb(side: Side, spot: number, lo: number, hi: number, s: number): number {
  const p = probInside(spot, lo, hi, s);
  return side === 'in' ? p : 1 - p;
}

/** Probability density of the settlement price at K. */
export function density(spot: number, k: number, s: number): number {
  const z = (Math.log(k / spot) + 0.5 * s * s) / s;
  return Math.exp(-0.5 * z * z) / (k * s * Math.sqrt(2 * Math.PI));
}

export const multiplier = (p: number) => (1 - FEE) / p;

/** What the pool pays to close a bet early: fair value minus the fee. */
export const markValue = (payout: number, p: number) => payout * p * (1 - FEE);

export function isWin(side: Side, lo: number, hi: number, price: number): boolean {
  const inside = price >= lo && price <= hi;
  return side === 'in' ? inside : !inside;
}

export interface QuoteInput { side: Side; spot: number; vol: number; msLeft: number; lo: number; hi: number }
export type Quote = { ok: true; prob: number; mult: number } | { ok: false; prob: number; reason: string };

export function quote({ side, spot, vol, msLeft, lo, hi }: QuoteInput): Quote {
  if (!(lo > 0) || !(hi > lo)) return { ok: false, prob: 0, reason: 'The upper bound must be above the lower bound.' };
  const prob = winProb(side, spot, lo, hi, sigma(vol, msLeft));
  if (prob < MIN_PROB) {
    return { ok: false, prob, reason: side === 'in'
      ? 'This range is too unlikely to price. Widen it or move it closer to the mark.'
      : 'This range covers almost every outcome. Narrow it to bet outside.' };
  }
  if (prob > MAX_PROB) {
    return { ok: false, prob, reason: side === 'in'
      ? 'This range is almost certain to win, so it would pay under 1.02×. Narrow it.'
      : 'Settling outside this range is almost certain. Widen the range or move it closer to the mark.' };
  }
  return { ok: true, prob, mult: multiplier(prob) };
}

export function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * e;
}

/** Ladder bucket width: about 0.45σ of the move expected by expiry, rounded to a nice number. */
export function ladderStep(spot: number, vol: number, msLeft: number): number {
  return niceStep(spot * sigma(vol, msLeft) * 0.45);
}
