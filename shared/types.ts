export interface Candle { t: number; o: number; h: number; l: number; c: number }

export type Side = 'in' | 'out';
export type BetStatus = 'open' | 'won' | 'lost' | 'partial' | 'closed' | 'void';
/** 'model': priced by the flat-vol lognormal model (practice expiries). 'opt': priced off a venue's option marks. */
export type BetKind = 'model' | 'opt';
export type Venue = 'derive' | 'hypercall';
export type PriceSource = 'coinbase' | 'sim';

export interface Bet {
  id: number;
  sym: string;
  series: string;
  side: Side;
  lo: number;
  hi: number;
  stake: number;
  mult: number;
  payout: number;
  prob: number;
  spot: number;
  createdAt: number;
  expiresAt: number;
  status: BetStatus;
  settlePrice: number | null;
  returned: number | null;
  closedAt: number | null;
  kind: BetKind;
  /** Ramp widths below lo and above hi for options-backed bets (one strike step each); 0 for model bets. */
  wl: number;
  wh: number;
}

export interface Account {
  id: string;
  name: string;
  balance: number;
  open: Bet[];
  history: Bet[];
}

export interface AssetInfo {
  sym: string;
  name: string;
  dec: number;
  vol: number;
  source: PriceSource;
  price: number;
  chg24h: number;
  live: boolean;
}

export interface PoolInfo { balance: number; liability: number }

export interface ExpirySeries { key: string; label: string; gran: number }

export interface MarketsResponse {
  serverTime: number;
  fee: number;
  cutoffMs: number;
  assets: AssetInfo[];
  series: ExpirySeries[];
  pool: PoolInfo;
}

export interface PricesEvent {
  t: number;
  assets: Record<string, { price: number; chg24h: number; live: boolean }>;
  pool: PoolInfo;
}

export interface LeaderRow { name: string; equity: number; pnl: number; openBets: number; you: boolean }

/**
 * One expiry of a venue's option chain, reduced to what pricing needs. `call` is the call mark at each strike
 * (from the put mark via put–call parity below the forward).
 */
export interface OptCurve {
  venue: Venue;
  sym: string;
  expiry: number;
  strikes: number[];
  call: number[];
  /** Executable call-equivalent bid / ask at each strike (0 = no quote), and the venue's taker fee per contract. */
  bid: number[];
  ask: number[];
  fee: number[];
  fwd: number;
  atmIv: number;
  updatedAt: number;
}

/** House book for one options-backed series, evaluated on `grid` (see bookGrid). */
export interface OptBook {
  grid: number[];
  /** What open bets pay at each grid price. */
  liab: number[];
  /** What the shadow hedge pays at each grid price (perps count as qty × price, their entry cost is in `cash`). */
  hedge: number[];
  /** Stakes of open bets minus hedge premiums and fees paid. */
  cash: number;
  /** Worst-case loss (see worstLoss) above which the shadow hedger acts. */
  limit: number;
}

export interface OptSeriesInfo {
  key: string;
  sym: string;
  venue: Venue;
  expiry: number;
  /** Betting closes this long before expiry (the settlement TWAP window). */
  open: boolean;
  curve: OptCurve;
  book: OptBook;
}

export interface CurvesEvent { t: number; series: OptSeriesInfo[] }
