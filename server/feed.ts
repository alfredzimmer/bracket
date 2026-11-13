import { ASSETS, type AssetConfig } from '../shared/markets.ts';
import type { Candle, PriceSource } from '../shared/types.ts';
import { config } from './config.ts';
import { q } from './db.ts';

/** Candle sizes kept in memory (seconds). Matches the chart granularity of each expiry series. */
export const GRANS = [60, 300, 900, 3600, 21600];
const KEEP = 420;
const YEAR_MS = 365 * 24 * 3_600_000;
const COINBASE_REST = 'https://api.exchange.coinbase.com';
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export class Market {
  cfg: AssetConfig;
  source: PriceSource;
  price = 0;
  lastTick = 0;
  series = new Map<number, Candle[]>();

  constructor(cfg: AssetConfig) {
    this.cfg = cfg;
    this.source = cfg.source;
    for (const g of GRANS) this.series.set(g, []);
  }

  tick(price: number, ts: number) {
    if (!(price > 0)) return;
    this.price = price;
    this.lastTick = Math.max(this.lastTick, ts);
    const sec = Math.floor(ts / 1000);
    for (const g of GRANS) {
      const arr = this.series.get(g)!;
      const bucket = sec - (sec % g);
      const last = arr.at(-1);
      if (last && last.t === bucket) {
        last.h = Math.max(last.h, price);
        last.l = Math.min(last.l, price);
        last.c = price;
      } else if (!last || bucket > last.t) {
        arr.push({ t: bucket, o: price, h: price, l: price, c: price });
        if (arr.length > KEEP) arr.splice(0, arr.length - KEEP);
      }
    }
  }

  live(now: number): boolean {
    return this.price > 0 && now - this.lastTick < config.staleMs;
  }

  change24h(now: number): number {
    const arr = this.series.get(900)!;
    const target = now / 1000 - 86_400;
    let ref: Candle | undefined;
    for (const c of arr) { if (c.t <= target) ref = c; else break; }
    ref ??= arr[0];
    return ref ? this.price / ref.c - 1 : 0;
  }

  /** First traded price at or after `ts` (the open of the 1-minute candle starting then), if we have it. */
  priceAt(ts: number): number | undefined {
    const t = Math.floor(ts / 60_000) * 60;
    return this.series.get(60)!.find(c => c.t === t)?.o;
  }

  candles(gran: number): Candle[] {
    return this.series.get(gran) ?? [];
  }
}

export const markets = new Map<string, Market>(ASSETS.map(a => [a.sym, new Market(a)]));

/* ---------- simulated markets ---------- */

function simulateHistory(m: Market, end: number, endPrice: number) {
  // Walk backward from the current price so history ends exactly where live ticks start.
  const pts: [number, number][] = [];
  const horizon = KEEP * GRANS.at(-1)! * 1000;
  let p = endPrice;
  for (let t = end; t > end - horizon;) {
    pts.push([t, p]);
    const dt = t > end - 8 * 3_600_000 ? 5_000 : 60_000;
    p *= Math.exp(-m.cfg.vol * Math.sqrt(dt / YEAR_MS) * gauss());
    t -= dt;
  }
  for (let i = pts.length - 1; i >= 0; i--) m.tick(pts[i][1], pts[i][0]);
}

function startSim(m: Market, price: number) {
  m.source = 'sim';
  simulateHistory(m, Date.now(), price);
  const stepSd = m.cfg.vol * Math.sqrt(1000 / YEAR_MS);
  setInterval(() => m.tick(m.price * Math.exp(stepSd * gauss()), Date.now()), 1000).unref();
}

export function saveSimState() {
  const now = Date.now();
  for (const m of markets.values()) if (m.source === 'sim' && m.price > 0) q.saveSim.run(m.cfg.sym, m.price, now);
}

/* ---------- Coinbase ---------- */

async function backfill(m: Market) {
  const product = m.cfg.product!;
  const rows: Candle[][] = [];
  for (const g of GRANS) {
    const res = await fetch(`${COINBASE_REST}/products/${product}/candles?granularity=${g}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Coinbase candles ${product} ${g}s: HTTP ${res.status}`);
    // Rows are [time, low, high, open, close, volume], newest first.
    const data = (await res.json()) as number[][];
    rows.push(data.map(([t, l, h, o, c]) => ({ t, o, h, l, c })).reverse());
  }
  GRANS.forEach((g, i) => m.series.set(g, rows[i]));
  m.price = rows[0].at(-1)?.c ?? 0;
}

/** Fetch the open of the 1-minute candle starting at `ts`, for settling bets after downtime. */
export async function fetchCoinbasePriceAt(m: Market, ts: number): Promise<number | undefined> {
  const start = new Date(ts).toISOString();
  const end = new Date(ts + 60_000).toISOString();
  const res = await fetch(`${COINBASE_REST}/products/${m.cfg.product}/candles?granularity=60&start=${start}&end=${end}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return undefined;
  const rows = (await res.json()) as number[][];
  return rows.find(r => r[0] * 1000 === ts)?.[3];
}

function connectCoinbase(live: Market[]) {
  let backoff = 1000;
  const bySym = new Map(live.map(m => [m.cfg.product!, m]));
  const open = () => {
    const ws = new WebSocket(COINBASE_WS);
    ws.onopen = () => {
      backoff = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: [...bySym.keys()], channels: ['ticker'] }));
      console.log(`[feed] Coinbase connected (${[...bySym.keys()].join(', ')})`);
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== 'ticker') return;
      bySym.get(msg.product_id)?.tick(Number(msg.price), msg.time ? Date.parse(msg.time) : Date.now());
    };
    ws.onclose = () => {
      console.warn(`[feed] Coinbase disconnected, retrying in ${backoff / 1000}s`);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}

export async function startFeeds() {
  const live: Market[] = [];
  for (const m of markets.values()) {
    if (m.cfg.source === 'coinbase' && !config.simOnly) {
      try {
        await backfill(m);
        live.push(m);
        continue;
      } catch (e) {
        console.warn(`[feed] ${m.cfg.sym}: Coinbase backfill failed, simulating instead. ${(e as Error).message}`);
      }
    }
    const saved = q.simState.get(m.cfg.sym) as { price: number } | undefined;
    startSim(m, saved?.price ?? m.cfg.seed);
  }
  if (live.length) connectCoinbase(live);
  setInterval(saveSimState, 10_000).unref();
}
