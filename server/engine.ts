import { randomBytes, randomUUID } from 'node:crypto';
import { ASSET_BY_SYM, SERIES, nextExpiry } from '../shared/markets.ts';
import { optMarkValue, parseOptSeries, rangeFair, rangeMarkValue, rangeQuote, rangeShape, rangeValue, sideFraction } from '../shared/options.ts';
import { FEE, isWin, markValue, quote, sigma, winProb } from '../shared/pricing.ts';
import type { Account, LeaderRow, PoolInfo, Side } from '../shared/types.ts';
import { config } from './config.ts';
import { type BetRow, type UserRow, cents, q, toBet, tx, usd } from './db.ts';
import { fetchCoinbasePriceAt, markets } from './feed.ts';
import { bookFor } from './options/book.ts';
import { chainFor, curveOf, seriesFor } from './options/chains.ts';
import { settleShadow } from './options/hedger.ts';
import { deriveSettlements } from './options/venues.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ---------- accounts ---------- */

export function createUser(): UserRow {
  const user: UserRow = {
    id: randomUUID(),
    token: randomBytes(24).toString('base64url'),
    name: `trader-${randomBytes(2).toString('hex')}`,
    balance: cents(config.startBalance),
    created_at: Date.now(),
  };
  q.insertUser.run(user.id, user.token, user.name, user.balance, user.created_at);
  return user;
}

export function account(userId: string): Account {
  const u = q.userById.get(userId) as unknown as UserRow;
  return {
    id: u.id,
    name: u.name,
    balance: usd(u.balance),
    open: (q.openBets.all(userId) as unknown as BetRow[]).map(toBet),
    history: (q.history.all(userId) as unknown as BetRow[]).map(toBet),
  };
}

/** Back to the starting balance. Open bets are voided without refund; the stake stays in the pool. */
export function resetAccount(userId: string) {
  tx(() => {
    q.voidOpenForUser.run(Date.now(), userId);
    q.setBalance.run(cents(config.startBalance), userId);
  });
}

export function poolInfo(): PoolInfo {
  const bal = (q.pool.get() as { balance: number }).balance;
  const liab = (q.liability.get() as { v: number }).v;
  return { balance: usd(bal), liability: usd(liab) };
}

/* ---------- placing and closing ---------- */

export interface PlaceInput { sym: string; series: string; side: Side; lo: number; hi: number; stake: number; minMult?: number }

export function parsePlace(b: Record<string, unknown>): PlaceInput {
  const { sym, series, side, lo, hi, stake, minMult } = b;
  if (typeof sym !== 'string' || !ASSET_BY_SYM[sym]) throw new HttpError(400, 'Unknown market.');
  const optExpiry = typeof series === 'string' ? parseOptSeries(series) : null;
  if (optExpiry !== null ? !ASSET_BY_SYM[sym].opt : typeof series !== 'string' || !SERIES.some(s => s.key === series)) {
    throw new HttpError(400, 'Unknown expiry.');
  }
  if (side !== 'in' && side !== 'out') throw new HttpError(400, 'Side must be "in" or "out".');
  for (const [k, v] of Object.entries({ lo, hi, stake })) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new HttpError(400, `${k} must be a positive number.`);
  }
  if (minMult !== undefined && (typeof minMult !== 'number' || !Number.isFinite(minMult))) throw new HttpError(400, 'minMult must be a number.');
  return { sym, series: series as string, side, lo: lo as number, hi: hi as number, stake: stake as number, minMult: minMult as number | undefined };
}

/** Pool limits shared by both kinds of bet. Runs inside the placing transaction. */
function checkPool(stakeC: number, payoutC: number) {
  const pool = (q.pool.get() as { balance: number }).balance;
  const liability = (q.liability.get() as { v: number }).v;
  const maxPayout = Math.floor(pool * config.maxPayoutFraction);
  if (payoutC > maxPayout) {
    throw new HttpError(400, `Payout is capped at ${usd(maxPayout).toLocaleString('en-US')} USDC per bet. Lower your stake.`);
  }
  if (liability + payoutC > pool + stakeC) throw new HttpError(503, 'The pool is fully used right now. Try a smaller bet.');
}

function liveOptSeries(sym: string, expiry: number, now: number) {
  const s = seriesFor(sym, expiry, now);
  if (!s) throw new HttpError(400, 'This options-backed expiry is no longer offered.');
  if (!s.open) {
    throw new HttpError(409, s.expiry - now <= config.optCutoffMs
      ? 'Betting on this expiry has closed: the settlement price is being averaged over its last 30 minutes.'
      : `${s.venue === 'derive' ? 'Derive' : 'Hypercall'} option quotes for ${sym} are stale. Betting resumes when they update.`);
  }
  return s;
}

function placeOptBet(userId: string, inp: PlaceInput, expiry: number) {
  const now = Date.now();
  const stakeC = cents(inp.stake);
  if (stakeC < 100) throw new HttpError(400, 'The minimum stake is 1 USDC.');
  const s = liveOptSeries(inp.sym, expiry, now);
  const book = bookFor(s.venue, s.sym, s.expiry, s.curve);
  const qt = rangeQuote({ curve: s.curve, book, side: inp.side, lo: inp.lo, hi: inp.hi, stake: inp.stake });
  if (!qt.ok) throw new HttpError(400, qt.reason);
  if (inp.minMult && qt.mult < inp.minMult) {
    throw new HttpError(409, `The market moved and this range now pays ${qt.mult.toFixed(2)}×. Check the new quote and place again.`);
  }
  const h = qt.hedge;
  const payoutC = Math.floor(stakeC * qt.mult);
  return tx(() => {
    checkPool(stakeC, payoutC);
    if (Number(q.debit.run(stakeC, userId, stakeC).changes) === 0) throw new HttpError(400, 'Your stake is more than your available balance.');
    q.poolAdd.run(stakeC);
    const r = q.insertBet.run(userId, inp.sym, inp.series, inp.side, inp.lo, inp.hi, stakeC, qt.mult, payoutC, qt.prob, s.curve.fwd, now, s.expiry,
      'opt', 0, 0, h?.[0] ?? null, h?.[1] ?? null, h?.[2] ?? null, h?.[3] ?? null);
    return toBet(q.betById.get(r.lastInsertRowid) as unknown as BetRow);
  });
}

export function placeBet(userId: string, inp: PlaceInput) {
  const optExpiry = parseOptSeries(inp.series);
  if (optExpiry !== null) return placeOptBet(userId, inp, optExpiry);
  const now = Date.now();
  const m = markets.get(inp.sym)!;
  if (!m.live(now)) throw new HttpError(503, `The ${inp.sym} price feed is down. Betting resumes when it reconnects.`);
  const stakeC = cents(inp.stake);
  if (stakeC < 100) throw new HttpError(400, 'The minimum stake is 1 USDC.');

  const expiresAt = nextExpiry(inp.series, now);
  const qt = quote({ side: inp.side, spot: m.price, vol: m.cfg.vol, msLeft: expiresAt - now, lo: inp.lo, hi: inp.hi });
  if (!qt.ok) throw new HttpError(400, qt.reason);
  if (inp.minMult && qt.mult < inp.minMult) {
    throw new HttpError(409, `The price moved and this range now pays ${qt.mult.toFixed(2)}×. Check the new quote and place again.`);
  }
  const payoutC = Math.floor(stakeC * qt.mult);

  return tx(() => {
    checkPool(stakeC, payoutC);
    if (Number(q.debit.run(stakeC, userId, stakeC).changes) === 0) throw new HttpError(400, 'Your stake is more than your available balance.');
    q.poolAdd.run(stakeC);
    const r = q.insertBet.run(userId, inp.sym, inp.series, inp.side, inp.lo, inp.hi, stakeC, qt.mult, payoutC, qt.prob, m.price, now, expiresAt, 'model', 0, 0, null, null, null, null);
    return toBet(q.betById.get(r.lastInsertRowid) as unknown as BetRow);
  });
}

/** Current value of $1 of this bet's payout: the options market's price for opt bets, the model's for the rest. */
function liveWinProb(b: BetRow, now: number): number {
  if (b.kind === 'opt') {
    const ch = chainFor(ASSET_BY_SYM[b.sym].opt!, b.sym, b.expires_at);
    const curve = ch && curveOf(ch);
    if (!curve) return b.prob;
    if (b.wl <= 0) return rangeFair(curve, b.side, b.lo, b.hi);
    const shape = rangeShape(curve.strikes, b.lo, b.hi);
    return shape ? rangeValue(curve, shape, b.side) : b.prob;
  }
  const m = markets.get(b.sym)!;
  return winProb(b.side, m.price, b.lo, b.hi, sigma(m.cfg.vol, b.expires_at - now));
}

export function closeBet(userId: string, betId: number, minValue?: number) {
  const now = Date.now();
  const b = q.betById.get(betId) as unknown as BetRow | undefined;
  if (!b || b.user_id !== userId) throw new HttpError(404, 'Bet not found.');
  if (b.status !== 'open') throw new HttpError(409, 'This bet is already closed.');
  if (b.expires_at <= now) throw new HttpError(409, 'This bet has expired and is settling.');
  let valueC: number;
  if (b.kind === 'opt') {
    const s = liveOptSeries(b.sym, b.expires_at, now);
    const v = b.wl <= 0 ? rangeMarkValue(s.curve, b.side, b.lo, b.hi, b.payout) : optMarkValue(s.curve, b.side, b.lo, b.hi, b.payout);
    if (v === null) throw new HttpError(503, "The hedge for this bet can't be unwound right now (a strike has no quote). Try again shortly.");
    valueC = Math.floor(v);
  } else {
    if (!markets.get(b.sym)!.live(now)) throw new HttpError(503, `The ${b.sym} price feed is down. Try again when it reconnects.`);
    valueC = Math.floor(markValue(b.payout, liveWinProb(b, now)));
  }
  if (minValue !== undefined && usd(valueC) < minValue) {
    throw new HttpError(409, `The price moved and this bet is now worth ${usd(valueC).toFixed(2)} USDC. Try again.`);
  }
  tx(() => {
    const px = b.kind === 'opt' ? chainFor(ASSET_BY_SYM[b.sym].opt!, b.sym, b.expires_at)!.fwd : markets.get(b.sym)!.price;
    if (Number(q.finishBet.run('closed', px, valueC, now, b.id, 'open').changes) === 0) {
      throw new HttpError(409, 'This bet is already closed.');
    }
    q.credit.run(valueC, userId);
    q.poolAdd.run(-valueC);
  });
  return toBet(q.betById.get(b.id) as unknown as BetRow);
}

/* ---------- settlement ---------- */

const fetching = new Set<string>();

function settlementPrice(sym: string, expiresAt: number, now: number): number | 'void' | undefined {
  const saved = q.settlement.get(sym, expiresAt) as { price: number } | undefined;
  if (saved) return saved.price;
  const m = markets.get(sym)!;
  const p = m.priceAt(expiresAt);
  if (p !== undefined) {
    q.insertSettlement.run(sym, expiresAt, p);
    return p;
  }
  // No tick since expiry in memory. Live markets can look it up; otherwise wait, then refund.
  const key = `${sym}:${expiresAt}`;
  if (m.source === 'coinbase' && now - expiresAt > 15_000 && !fetching.has(key)) {
    fetching.add(key);
    fetchCoinbasePriceAt(m, expiresAt)
      .then(price => { if (price !== undefined) q.insertSettlement.run(sym, expiresAt, price); })
      .catch(() => {})
      .finally(() => setTimeout(() => fetching.delete(key), 30_000));
  }
  return now - expiresAt > config.voidAfterMs ? 'void' : undefined;
}

/** Venue-published settlement price for an options-backed series, fetched in the background until it appears. */
const lastLookup = new Map<string, number>();
function optSettlementPrice(sym: string, expiresAt: number, now: number): number | 'void' | undefined {
  const venue = ASSET_BY_SYM[sym].opt!;
  const saved = q.optSettlement.get(venue, sym, expiresAt) as { price: number } | undefined;
  if (saved) return saved.price;
  if (now - (lastLookup.get(sym) ?? 0) > 30_000 && venue === 'derive') {
    lastLookup.set(sym, now);
    deriveSettlements(sym)
      .then(prices => { for (const [exp, price] of prices) if (price > 0) q.insertOptSettlement.run(venue, sym, exp, price); })
      .catch(e => console.warn(`[settle] Derive ${sym} settlement lookup failed: ${(e as Error).message}`));
  }
  return now - expiresAt > config.optVoidAfterMs ? 'void' : undefined;
}

function settleOptDue(notify: (userId: string) => void, now: number) {
  const due = new Map<string, { sym: string; expires_at: number }>();
  for (const d of q.dueExpiries.all('opt', now) as { sym: string; expires_at: number }[]) due.set(`${d.sym}:${d.expires_at}`, d);
  // A series whose bets were all closed early can still hold shadow hedges that need settling.
  for (const p of q.allShadowPositions.all() as { sym: string; expiry: number }[]) {
    if (p.expiry <= now && ASSET_BY_SYM[p.sym]?.opt) due.set(`${p.sym}:${p.expiry}`, { sym: p.sym, expires_at: p.expiry });
  }
  for (const { sym, expires_at } of due.values()) {
    const price = optSettlementPrice(sym, expires_at, now);
    if (price === undefined) continue;
    const bets = q.openFor.all('opt', sym, expires_at) as unknown as BetRow[];
    tx(() => {
      for (const b of bets) {
        if (price === 'void') {
          q.finishBet.run('void', null, b.stake, now, b.id, 'open');
          q.credit.run(b.stake, b.user_id);
          q.poolAdd.run(-b.stake);
          continue;
        }
        const frac = sideFraction(b.side, b.lo, b.hi, b.wl, b.wh, price);
        const ret = Math.floor(b.payout * frac);
        q.finishBet.run(frac >= 1 ? 'won' : ret <= 0 ? 'lost' : 'partial', price, ret, now, b.id, 'open');
        if (ret > 0) {
          q.credit.run(ret, b.user_id);
          q.poolAdd.run(-ret);
        }
      }
      if (price !== 'void') settleShadow(ASSET_BY_SYM[sym].opt!, sym, expires_at, price, now);
      else q.clearShadow.run(ASSET_BY_SYM[sym].opt!, sym, expires_at);
    });
    for (const id of new Set(bets.map(b => b.user_id))) notify(id);
    console.log(`[settle] ${sym} options-backed @ ${new Date(expires_at).toISOString()}: ${bets.length} bet(s) at ${price}`);
  }
}

export function settleDue(notify: (userId: string) => void) {
  const now = Date.now();
  settleOptDue(notify, now);
  const due = q.dueExpiries.all('model', now) as { sym: string; expires_at: number }[];
  for (const { sym, expires_at } of due) {
    const price = settlementPrice(sym, expires_at, now);
    if (price === undefined) continue;
    const bets = q.openFor.all('model', sym, expires_at) as unknown as BetRow[];
    tx(() => {
      for (const b of bets) {
        if (price === 'void') {
          q.finishBet.run('void', null, b.stake, now, b.id, 'open');
          q.credit.run(b.stake, b.user_id);
          q.poolAdd.run(-b.stake);
          continue;
        }
        const won = isWin(b.side, b.lo, b.hi, price);
        q.finishBet.run(won ? 'won' : 'lost', price, won ? b.payout : 0, now, b.id, 'open');
        if (won) {
          q.credit.run(b.payout, b.user_id);
          q.poolAdd.run(-b.payout);
        }
      }
    });
    for (const id of new Set(bets.map(b => b.user_id))) notify(id);
    console.log(`[settle] ${sym} @ ${new Date(expires_at).toISOString()}: ${bets.length} bet(s) at ${price}`);
  }
}

/* ---------- leaderboard ---------- */

export function leaderboard(youId: string | null): LeaderRow[] {
  const now = Date.now();
  const open = q.allOpen.all() as unknown as BetRow[];
  const openValue = new Map<string, { v: number; n: number }>();
  for (const b of open) {
    const cur = openValue.get(b.user_id) ?? { v: 0, n: 0 };
    cur.v += b.payout * liveWinProb(b, now) * (1 - FEE);
    cur.n += 1;
    openValue.set(b.user_id, cur);
  }
  const users = q.leaderUsers.all() as { id: string; name: string; balance: number }[];
  return users
    .map(u => {
      const o = openValue.get(u.id) ?? { v: 0, n: 0 };
      const equity = usd(u.balance + o.v);
      return { name: u.name, equity, pnl: equity - config.startBalance, openBets: o.n, you: u.id === youId };
    })
    .sort((a, b) => b.equity - a.equity)
    .slice(0, 25);
}
