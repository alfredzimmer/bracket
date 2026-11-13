import type { Account, Bet, Candle, CurvesEvent, LeaderRow, MarketsResponse, Side } from '../shared/types.ts';

const TOKEN_KEY = 'bracket.token';

let token: string | null = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the Bracket server. Check that it's running.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed with status ${res.status}.`);
  return data as T;
}

export interface PlaceBody { sym: string; series: string; side: Side; lo: number; hi: number; stake: number; minMult: number }

export const api = {
  markets: () => call<MarketsResponse>('GET', '/api/markets'),
  candles: (sym: string, gran: number) => call<Candle[]>('GET', `/api/candles?sym=${sym}&gran=${gran}`),
  me: () => call<Account>('GET', '/api/me'),
  reset: () => call<Account>('POST', '/api/me/reset'),
  place: (body: PlaceBody) => call<{ bet: Bet; account: Account }>('POST', '/api/bets', body),
  close: (id: number, minValue: number) => call<{ bet: Bet; account: Account }>('POST', `/api/bets/${id}/close`, { minValue }),
  leaderboard: () => call<LeaderRow[]>('GET', '/api/leaderboard'),
  opt: () => call<CurvesEvent>('GET', '/api/opt'),
  recent: () => call<RecentBet[]>('GET', '/api/recent'),
  desk: () => call<DeskData>('GET', '/api/desk'),
  streamUrl: () => `/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`,

  /** Resume the saved paper account, or open a new one. */
  async session(): Promise<Account> {
    if (token) {
      try {
        return await api.me();
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    }
    const r = await call<{ token: string; account: Account }>('POST', '/api/session');
    token = r.token;
    try { localStorage.setItem(TOKEN_KEY, r.token); } catch {}
    return r.account;
  },
};

/* ---------- Desk (research + shadow hedger), shaped by server/index.ts desk() ---------- */

export interface SpreadRow {
  venue: string; sym: string; tenor: string; shape: string; quoteKind: string; n: number;
  executable: number; mark: number; buyMarkup: number | null; sellMarkup: number | null; fee: number;
}

export interface DeskPosition { instrument: string; type: 'C' | 'P' | 'PERP'; strike: number; qty: number; cost: number; mark: number; value: number }

export interface DeskSeries {
  sym: string; venue: string; expiry: number; open: boolean; fwd: number; atmIv: number;
  grid: number[]; liab: number[]; hedge: number[]; cash: number; limit: number;
  bets: number; stakes: number; fees: number; slippage: number;
  worstHedged: number; worstUnhedged: number;
  liabValue: number; hedgePnl: number; pnl: number;
  positions: DeskPosition[];
}

export interface DeskFill { id: number; t: number; venue: string; sym: string; expiry: number; instrument: string; qty: number; price: number; mark: number; fee: number; note: string }

export interface DeskResult {
  venue: string; sym: string; expiry: number; settle_price: number; bets: number; stakes: number; paid_out: number;
  hedge_payoff: number; hedge_cost: number; hedge_fees: number; t: number;
}

export interface DeskData { t: number; riskLimit: number; spreads: SpreadRow[]; series: DeskSeries[]; fills: DeskFill[]; results: DeskResult[] }

/** A recent bet from anyone, for the tape. */
export interface RecentBet { id: number; sym: string; side: 'in' | 'out'; lo: number; hi: number; mult: number; stake: number; kind: string; t: number }
