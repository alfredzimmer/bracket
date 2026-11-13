/**
 * Keeps the latest option chain for every (venue, underlying, expiry) in memory, and turns chains into the
 * reduced OptCurve the pricing module uses. Derive backs the tradable series; Hypercall is polled for research.
 */
import { ASSETS } from '../../shared/markets.ts';
import type { OptCurve, Venue } from '../../shared/types.ts';
import { config } from '../config.ts';
import { feePerContract } from './exec.ts';
import { type Chain, type DeriveExpiry, deriveChain, deriveExpiries, hypercallChains } from './venues.ts';

export const chains = new Map<string, Chain>();
export const chainKey = (venue: Venue, sym: string, expiry: number) => `${venue}:${sym}:${expiry}`;

/** Underlyings Hypercall is polled for (research only). */
const HYPERCALL_SYMS = ['BTC', 'ETH'];

export const isFresh = (ch: Chain, now: number) => now - ch.updatedAt < config.optStaleMs;

/* ---------- chain → curve ---------- */

const curveCache = new WeakMap<Chain, OptCurve | null>();

/**
 * Call price at each strike, taken from the out-of-the-money option (calls at or above the forward, puts below,
 * converted with put–call parity C = P + F − K). OTM marks are the liquid, well-fitted side of a venue's surface.
 * Alongside the mark, the curve carries what the house would really pay: the same option's bid and ask (also as call
 * equivalents, 0 when missing) and the venue's fee per contract. That is the instrument the hedger trades.
 */
export function curveOf(ch: Chain): OptCurve | null {
  if (curveCache.has(ch)) return curveCache.get(ch)!;
  let curve: OptCurve | null = null;
  if (ch.fwd > 0) {
    const rows: { k: number; call: number; bid: number; ask: number; fee: number }[] = [];
    let atmIv = 0, atmGap = Infinity;
    for (const r of ch.rows) {
      const otm = r.k >= ch.fwd ? r.c : r.p;
      const other = r.k >= ch.fwd ? r.p : r.c;
      const src = otm && otm.mark > 0 ? otm : other && other.mark > 0 ? other : otm;
      if (!src) continue;
      const adj = src === r.c ? 0 : ch.fwd - r.k;
      rows.push({
        k: r.k,
        call: Math.max(0, src.mark + adj),
        bid: src.bid > 0 ? Math.max(0, src.bid + adj) : 0,
        ask: src.ask > 0 ? src.ask + adj : 0,
        fee: feePerContract(ch, src.mark),
      });
      if (Math.abs(r.k - ch.fwd) < atmGap && src.iv > 0) { atmGap = Math.abs(r.k - ch.fwd); atmIv = src.iv; }
    }
    const clean = arbFree(rows);
    if (clean.length >= 5) {
      curve = {
        venue: ch.venue, sym: ch.sym, expiry: ch.expiry, fwd: ch.fwd, atmIv, updatedAt: ch.updatedAt,
        strikes: clean.map(r => r.k), call: clean.map(r => r.call),
        bid: clean.map(r => r.bid), ask: clean.map(r => r.ask), fee: clean.map(r => r.fee),
      };
    }
  }
  curveCache.set(ch, curve);
  return curve;
}

/**
 * Drops strikes whose call price breaks the basic no-arbitrage bounds against the last kept strike:
 * calls can't get dearer as the strike rises, or cheaper by more than the strike rises (slope in [−1, 0]).
 * A bad mark would otherwise price ranges that use it at more than their payout.
 */
function arbFree<T extends { k: number; call: number }>(rows: T[]): T[] {
  const kept: T[] = [];
  for (const r of rows) {
    const last = kept.at(-1);
    if (last && (r.call > last.call + 1e-9 || r.call < last.call - (r.k - last.k) - 1e-9)) continue;
    kept.push(r);
  }
  return kept;
}

/* ---------- which series are offered ---------- */

export interface LiveSeries { sym: string; venue: Venue; expiry: number; chain: Chain; curve: OptCurve; open: boolean }

/** Options-backed series for every asset with an `opt` venue: expiries within optMaxDays that have a usable curve. */
export function liveSeries(now: number): LiveSeries[] {
  const out: LiveSeries[] = [];
  for (const a of ASSETS) {
    if (!a.opt) continue;
    for (const ch of chains.values()) {
      if (ch.venue !== a.opt || ch.sym !== a.sym || ch.expiry <= now) continue;
      const curve = curveOf(ch);
      if (!curve) continue;
      out.push({ sym: a.sym, venue: a.opt, expiry: ch.expiry, chain: ch, curve, open: ch.expiry - now > config.optCutoffMs && isFresh(ch, now) });
    }
  }
  return out.sort((x, y) => x.sym.localeCompare(y.sym) || x.expiry - y.expiry);
}

export function seriesFor(sym: string, expiry: number, now: number): LiveSeries | undefined {
  return liveSeries(now).find(s => s.sym === sym && s.expiry === expiry);
}

/** Latest chain for a series, even after expiry (used for the book until it settles). */
export function chainFor(venue: Venue, sym: string, expiry: number): Chain | undefined {
  return chains.get(chainKey(venue, sym, expiry));
}

/* ---------- polling ---------- */

const warned = new Set<string>();
function warnOnce(key: string, e: unknown) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[options] ${key}: ${(e as Error).message}`);
}
const ok = (key: string) => warned.delete(key);

const lists = new Map<string, { at: number; expiries: DeriveExpiry[] }>();

async function pollDerive() {
  const now = Date.now();
  const horizon = now + config.optMaxDays * 86_400_000;
  for (const a of ASSETS) {
    if (a.opt !== 'derive') continue;
    try {
      let list = lists.get(a.sym);
      if (!list || now - list.at > config.deriveListMs) {
        list = { at: now, expiries: await deriveExpiries(a.sym) };
        lists.set(a.sym, list);
      }
      for (const e of list.expiries) {
        if (e.expiry <= now || e.expiry > horizon) continue;
        const ch = await deriveChain(a.sym, e);
        chains.set(chainKey('derive', a.sym, e.expiry), ch);
      }
      ok(`derive ${a.sym}`);
    } catch (e) {
      warnOnce(`derive ${a.sym}`, e);
    }
  }
}

async function pollHypercall() {
  const now = Date.now();
  const horizon = now + config.optMaxDays * 86_400_000;
  for (const sym of HYPERCALL_SYMS) {
    try {
      for (const ch of await hypercallChains(sym)) {
        if (ch.expiry > now && ch.expiry <= horizon) chains.set(chainKey('hypercall', sym, ch.expiry), ch);
      }
      ok(`hypercall ${sym}`);
    } catch (e) {
      warnOnce(`hypercall ${sym}`, e);
    }
  }
}

/** Drops chains a day past expiry; by then their series have settled or been refunded. */
function prune() {
  const cutoff = Date.now() - 86_400_000;
  for (const [k, ch] of chains) if (ch.expiry < cutoff) chains.delete(k);
}

function loop(fn: () => Promise<void>, every: number) {
  const run = async () => {
    const t = Date.now();
    await fn().catch(e => console.error('[options]', e));
    setTimeout(run, Math.max(1000, every - (Date.now() - t))).unref();
  };
  return run();
}

export async function startOptionFeeds() {
  // Wait for the first Derive pass so options-backed series exist as soon as the API is up.
  await loop(pollDerive, config.derivePollMs);
  if (!config.hypercallOff) loop(pollHypercall, config.hypercallPollMs);
  setInterval(prune, 3_600_000).unref();
  const n = liveSeries(Date.now()).length;
  console.log(`[options] ${n} options-backed series from Derive`);
}
