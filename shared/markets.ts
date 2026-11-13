import type { ExpirySeries, PriceSource, Venue } from './types.ts';

export interface AssetConfig {
  sym: string;
  name: string;
  /** Decimal places shown for prices. */
  dec: number;
  /** Annualized volatility used to price ranges (and to drive simulated feeds). */
  vol: number;
  source: PriceSource;
  /** Coinbase product id for live assets. */
  product?: string;
  /** Starting price for simulated assets (or fallback if the live feed fails). */
  seed: number;
  /** Venue whose listed options back this asset's options-backed expiries (priced, settled and shadow-hedged there). */
  opt?: Venue;
}

export const ASSETS: AssetConfig[] = [
  { sym: 'BTC', name: 'Bitcoin', dec: 0, vol: 0.5, source: 'coinbase', product: 'BTC-USD', opt: 'derive', seed: 76000 },
  { sym: 'ETH', name: 'Ethereum', dec: 1, vol: 0.65, source: 'coinbase', product: 'ETH-USD', opt: 'derive', seed: 3400 },
  { sym: 'SOL', name: 'Solana', dec: 2, vol: 0.85, source: 'coinbase', product: 'SOL-USD', opt: 'derive', seed: 170 },
  { sym: 'XAU', name: 'Gold', dec: 1, vol: 0.16, source: 'sim', seed: 2680 },
  { sym: 'NVDA', name: 'NVIDIA', dec: 2, vol: 0.5, source: 'sim', seed: 141 },
  { sym: 'WTI', name: 'Crude oil', dec: 2, vol: 0.35, source: 'sim', seed: 71.8 },
  { sym: 'EURUSD', name: 'Euro / Dollar', dec: 4, vol: 0.07, source: 'sim', seed: 1.083 },
];

export const ASSET_BY_SYM: Record<string, AssetConfig> = Object.fromEntries(ASSETS.map(a => [a.sym, a]));

/** Each series settles at a fixed schedule (UTC). `gran` is the chart candle size in seconds. */
export const SERIES: ExpirySeries[] = [
  { key: '1h', label: 'Hourly', gran: 60 },
  { key: '4h', label: '4H', gran: 300 },
  { key: '1d', label: 'Daily', gran: 900 },
  { key: '1w', label: 'Weekly', gran: 3600 },
  { key: '1mo', label: 'Monthly', gran: 21600 },
];

/** Betting on an expiry closes this long before it settles; later bets roll to the next one. */
export const CUTOFF_MS = 2 * 60_000;

const H = 3_600_000;
const D = 24 * H;

function lastFriday(y: number, m: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0, 20));
  return last.getTime() - ((last.getUTCDay() - 5 + 7) % 7) * D;
}

/** The next settlement time still open for betting in a series. */
export function nextExpiry(key: string, now: number): number {
  const ok = (t: number) => t - now > CUTOFF_MS;
  const every = (period: number) => {
    let t = Math.ceil((now + 1) / period) * period;
    if (!ok(t)) t += period;
    return t;
  };
  const d = new Date(now);
  switch (key) {
    case '1h': return every(H);
    case '4h': return every(4 * H);
    case '1d': return every(D);
    case '1w': {
      const delta = (5 - d.getUTCDay() + 7) % 7;
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta, 20);
      if (!ok(t)) t += 7 * D;
      return t;
    }
    case '1mo': {
      let t = lastFriday(d.getUTCFullYear(), d.getUTCMonth());
      if (!ok(t)) t = lastFriday(d.getUTCFullYear(), d.getUTCMonth() + 1);
      return t;
    }
  }
  throw new Error(`Unknown expiry series: ${key}`);
}
