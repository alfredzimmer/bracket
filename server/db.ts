import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import type { Bet, BetKind, BetStatus, Side } from '../shared/types.ts';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- All money columns are integer cents.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    balance INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    sym TEXT NOT NULL,
    series TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('in', 'out')),
    lo REAL NOT NULL,
    hi REAL NOT NULL,
    stake INTEGER NOT NULL,
    mult REAL NOT NULL,
    payout INTEGER NOT NULL,
    prob REAL NOT NULL,
    spot REAL NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    settle_price REAL,
    returned INTEGER,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS bets_open ON bets (status, expires_at);
  CREATE INDEX IF NOT EXISTS bets_user ON bets (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance INTEGER NOT NULL
  );

  -- One settlement price per market and expiry, shared by every bet on it.
  CREATE TABLE IF NOT EXISTS settlements (
    sym TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (sym, expires_at)
  );

  -- Last price of simulated markets, so they resume where they left off.
  CREATE TABLE IF NOT EXISTS sim_state (
    sym TEXT PRIMARY KEY,
    price REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.prepare('INSERT OR IGNORE INTO pool (id, balance) VALUES (1, ?)').run(Math.round(config.poolStart * 100));

/* ----- options-backed markets (added after the first release, so bets gets its new columns by migration) ----- */

const betCols = new Set((db.prepare('PRAGMA table_info(bets)').all() as { name: string }[]).map(c => c.name));
// h1–h4: strikes of the condor the house holds for a hard-edged range bet (NULL when it's covered by cash alone).
for (const [col, def] of [['kind', "TEXT NOT NULL DEFAULT 'model'"], ['wl', 'REAL NOT NULL DEFAULT 0'], ['wh', 'REAL NOT NULL DEFAULT 0'],
  ['h1', 'REAL'], ['h2', 'REAL'], ['h3', 'REAL'], ['h4', 'REAL']]) {
  if (!betCols.has(col)) db.exec(`ALTER TABLE bets ADD COLUMN ${col} ${def}`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS bets_kind ON bets (kind, sym, expires_at, status);

  -- Settlement prices published by the venue. Separate from settlements so an hourly practice bet
  -- and an options-backed bet that expire at the same minute can settle on different sources.
  CREATE TABLE IF NOT EXISTS opt_settlements (
    venue TEXT NOT NULL,
    sym TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (venue, sym, expires_at)
  );

  -- Phase 0: what it would cost to buy or sell a range's condor on each venue, sampled every config.sampleMs.
  -- Costs are USD per $1 of payout. NULL exec cost means some leg had no quote.
  CREATE TABLE IF NOT EXISTS hedge_cost_samples (
    t INTEGER NOT NULL,
    venue TEXT NOT NULL,
    sym TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    quote_kind TEXT NOT NULL,
    shape TEXT NOT NULL,
    lo REAL NOT NULL,
    hi REAL NOT NULL,
    mark REAL NOT NULL,
    buy REAL,
    sell REAL,
    fee REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hedge_cost_t ON hedge_cost_samples (t);

  -- Phase 2: the shadow hedger's simulated positions. instrument is a venue name like BTC-20261120-70000-C
  -- or BTC-PERP; cost is total USD paid (negative when sold), so P&L = qty × value − cost.
  CREATE TABLE IF NOT EXISTS shadow_positions (
    venue TEXT NOT NULL,
    sym TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    instrument TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('C', 'P', 'PERP')),
    strike REAL NOT NULL,
    qty REAL NOT NULL,
    cost REAL NOT NULL,
    PRIMARY KEY (venue, sym, expiry, instrument)
  );

  CREATE TABLE IF NOT EXISTS shadow_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    t INTEGER NOT NULL,
    venue TEXT NOT NULL,
    sym TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    instrument TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    mark REAL NOT NULL,
    fee REAL NOT NULL,
    note TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shadow_fills_series ON shadow_fills (sym, expiry, t);

  -- One row per settled options-backed series: how the house did with and without the shadow hedge.
  CREATE TABLE IF NOT EXISTS shadow_results (
    venue TEXT NOT NULL,
    sym TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    settle_price REAL NOT NULL,
    bets INTEGER NOT NULL,
    stakes REAL NOT NULL,
    paid_out REAL NOT NULL,
    hedge_payoff REAL NOT NULL,
    hedge_cost REAL NOT NULL,
    hedge_fees REAL NOT NULL,
    t INTEGER NOT NULL,
    PRIMARY KEY (venue, sym, expiry)
  );
`);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const cents = (usd: number) => Math.round(usd * 100);
export const usd = (c: number) => c / 100;

export interface UserRow { id: string; token: string; name: string; balance: number; created_at: number }

export interface BetRow {
  id: number; user_id: string; sym: string; series: string; side: Side; lo: number; hi: number;
  stake: number; mult: number; payout: number; prob: number; spot: number;
  created_at: number; expires_at: number; status: BetStatus;
  settle_price: number | null; returned: number | null; closed_at: number | null;
  kind: BetKind; wl: number; wh: number;
  h1: number | null; h2: number | null; h3: number | null; h4: number | null;
}

export function toBet(r: BetRow): Bet {
  return {
    id: r.id, sym: r.sym, series: r.series, side: r.side, lo: r.lo, hi: r.hi,
    stake: usd(r.stake), mult: r.mult, payout: usd(r.payout), prob: r.prob, spot: r.spot,
    createdAt: r.created_at, expiresAt: r.expires_at, status: r.status,
    settlePrice: r.settle_price, returned: r.returned == null ? null : usd(r.returned), closedAt: r.closed_at,
    kind: r.kind, wl: r.wl, wh: r.wh,
  };
}

export const q = {
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, token, name, balance, created_at) VALUES (?, ?, ?, ?, ?)'),
  debit: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
  credit: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
  setBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),

  pool: db.prepare('SELECT balance FROM pool WHERE id = 1'),
  poolAdd: db.prepare('UPDATE pool SET balance = balance + ? WHERE id = 1'),
  liability: db.prepare("SELECT COALESCE(SUM(payout), 0) AS v FROM bets WHERE status = 'open'"),

  insertBet: db.prepare(`INSERT INTO bets (user_id, sym, series, side, lo, hi, stake, mult, payout, prob, spot, created_at, expires_at, kind, wl, wh, h1, h2, h3, h4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  betById: db.prepare('SELECT * FROM bets WHERE id = ?'),
  openBets: db.prepare("SELECT * FROM bets WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC"),
  history: db.prepare("SELECT * FROM bets WHERE user_id = ? AND status != 'open' ORDER BY COALESCE(closed_at, expires_at) DESC LIMIT 50"),
  allOpen: db.prepare("SELECT * FROM bets WHERE status = 'open'"),
  dueExpiries: db.prepare("SELECT DISTINCT sym, expires_at FROM bets WHERE status = 'open' AND kind = ? AND expires_at <= ?"),
  openFor: db.prepare("SELECT * FROM bets WHERE status = 'open' AND kind = ? AND sym = ? AND expires_at = ?"),
  finishBet: db.prepare('UPDATE bets SET status = ?, settle_price = ?, returned = ?, closed_at = ? WHERE id = ? AND status = ?'),
  voidOpenForUser: db.prepare("UPDATE bets SET status = 'void', returned = 0, closed_at = ? WHERE user_id = ? AND status = 'open'"),

  settlement: db.prepare('SELECT price FROM settlements WHERE sym = ? AND expires_at = ?'),
  insertSettlement: db.prepare('INSERT OR IGNORE INTO settlements (sym, expires_at, price) VALUES (?, ?, ?)'),

  optSettlement: db.prepare('SELECT price FROM opt_settlements WHERE venue = ? AND sym = ? AND expires_at = ?'),
  insertOptSettlement: db.prepare('INSERT OR IGNORE INTO opt_settlements (venue, sym, expires_at, price) VALUES (?, ?, ?, ?)'),
  optOpenBets: db.prepare("SELECT * FROM bets WHERE status = 'open' AND kind = 'opt'"),
  optSeriesBets: db.prepare("SELECT * FROM bets WHERE kind = 'opt' AND sym = ? AND expires_at = ?"),

  insertSample: db.prepare(`INSERT INTO hedge_cost_samples (t, venue, sym, expiry, quote_kind, shape, lo, hi, mark, buy, sell, fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  pruneSamples: db.prepare('DELETE FROM hedge_cost_samples WHERE t < ?'),
  samplesSince: db.prepare('SELECT * FROM hedge_cost_samples WHERE t >= ?'),

  shadowPositions: db.prepare('SELECT * FROM shadow_positions WHERE venue = ? AND sym = ? AND expiry = ?'),
  allShadowPositions: db.prepare('SELECT * FROM shadow_positions'),
  upsertShadow: db.prepare(`INSERT INTO shadow_positions (venue, sym, expiry, instrument, type, strike, qty, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (venue, sym, expiry, instrument) DO UPDATE SET qty = qty + excluded.qty, cost = cost + excluded.cost`),
  clearShadow: db.prepare('DELETE FROM shadow_positions WHERE venue = ? AND sym = ? AND expiry = ?'),
  insertFill: db.prepare(`INSERT INTO shadow_fills (t, venue, sym, expiry, instrument, qty, price, mark, fee, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  seriesFees: db.prepare('SELECT COALESCE(SUM(fee), 0) AS fee, COALESCE(SUM((price - mark) * qty), 0) AS slip FROM shadow_fills WHERE venue = ? AND sym = ? AND expiry = ?'),
  recentFills: db.prepare('SELECT * FROM shadow_fills ORDER BY id DESC LIMIT 60'),
  insertResult: db.prepare(`INSERT OR REPLACE INTO shadow_results (venue, sym, expiry, settle_price, bets, stakes, paid_out, hedge_payoff, hedge_cost, hedge_fees, t)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  results: db.prepare('SELECT * FROM shadow_results ORDER BY expiry DESC LIMIT 50'),

  recentBets: db.prepare('SELECT id, sym, side, lo, hi, mult, stake, kind, created_at FROM bets ORDER BY id DESC LIMIT 24'),

  leaderUsers: db.prepare(`SELECT u.id, u.name, u.balance FROM users u
    WHERE EXISTS (SELECT 1 FROM bets b WHERE b.user_id = u.id)`),

  simState: db.prepare('SELECT price FROM sim_state WHERE sym = ?'),
  saveSim: db.prepare('INSERT INTO sim_state (sym, price, updated_at) VALUES (?, ?, ?) ON CONFLICT (sym) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at'),
};
