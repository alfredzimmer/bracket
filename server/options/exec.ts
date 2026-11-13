/**
 * What it costs to actually trade a set of call legs on a venue: buy at the ask, sell at the bid, plus fees.
 * Each leg trades the out-of-the-money option at its strike; a put stands in for a call by put–call parity
 * (call = put + one unit of the underlying), and the underlying leg goes through the perp.
 */
import type { Leg } from '../../shared/options.ts';
import type { Venue } from '../../shared/types.ts';
import type { Chain, Quote } from './venues.ts';

export type OptType = 'C' | 'P';

/** Taker fee per contract: Derive charges min(0.03% of index, 12.5% of premium). Hypercall charges 0 for now. */
export function feePerContract(ch: Chain, premium: number): number {
  return ch.venue === 'derive' ? Math.min(0.0003 * ch.fwd, 0.125 * premium) : 0;
}

/** Flat fee per order (Derive's base fee). */
export const BASE_FEE: Record<Venue, number> = { derive: 0.5, hypercall: 0 };
/** Perp taker fee rate (Derive). */
export const PERP_FEE = 0.0003;

export const otmType = (ch: Chain, k: number): OptType => (k >= ch.fwd ? 'C' : 'P');

/** The raw quote of the C or P at strike k. */
export function quoteAt(ch: Chain, k: number, type: OptType): Quote | undefined {
  const row = ch.rows.find(r => r.k === k);
  return type === 'C' ? row?.c : row?.p;
}

/** Converts a put price into the equivalent call price at the same strike (C = P + F − K). */
export const toCallEquiv = (ch: Chain, k: number, type: OptType, px: number) => (type === 'C' ? px : px + ch.fwd - k);

export interface LegsCost {
  /** Value at marks, per unit of legs. */
  mark: number;
  /** Cost to put the legs on as a taker; null if any leg lacks the quote it needs. */
  exec: number | null;
  /** Per-contract fees (excludes the flat per-order fee). */
  fee: number;
}

/** Cost of acquiring `legs` (q > 0 buys, q < 0 sells), in the same units as q × call price. */
export function legsCost(ch: Chain, legs: Leg[]): LegsCost {
  let mark = 0, exec: number | null = 0, fee = 0;
  for (const { k, q } of legs) {
    const type = otmType(ch, k);
    const qt = quoteAt(ch, k, type);
    if (!qt) return { mark: NaN, exec: null, fee: 0 };
    mark += q * toCallEquiv(ch, k, type, qt.mark);
    const px = q > 0 ? qt.ask : qt.bid;
    if (exec !== null) exec = px > 0 ? exec + q * toCallEquiv(ch, k, type, px) : null;
    fee += Math.abs(q) * feePerContract(ch, qt.mark);
  }
  return { mark, exec, fee };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const strikeName = (k: number) => String(k).replace('.', '_');

export const instrumentName = (sym: string, expiry: number, k: number, type: OptType) => `${sym}-${ymd(expiry)}-${strikeName(k)}-${type}`;
export const perpName = (sym: string) => `${sym}-PERP`;
