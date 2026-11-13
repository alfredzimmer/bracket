import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { ASSETS, CUTOFF_MS, SERIES } from '../shared/markets.ts';
import { FEE } from '../shared/pricing.ts';
import { optSeriesKey, rangeFair, rangeShape, rangeValue } from '../shared/options.ts';
import type { CurvesEvent, MarketsResponse, PricesEvent } from '../shared/types.ts';
import { config } from './config.ts';
import { type UserRow, db, q } from './db.ts';
import { HttpError, account, closeBet, createUser, leaderboard, parsePlace, placeBet, poolInfo, resetAccount, settleDue } from './engine.ts';
import { GRANS, markets, saveSimState, startFeeds } from './feed.ts';
import { bookFor, publicBook } from './options/book.ts';
import { liveSeries, startOptionFeeds } from './options/chains.ts';
import { quoteAt } from './options/exec.ts';
import { startHedger } from './options/hedger.ts';
import { spreadSummary, startResearch } from './options/research.ts';

/* ---------- helpers ---------- */

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'Request body is too large.');
  }
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, 'Request body must be a JSON object.');
}

function userFrom(token: string | null | undefined): UserRow | undefined {
  return token ? (q.userByToken.get(token) as unknown as UserRow | undefined) : undefined;
}

function requireUser(req: IncomingMessage): UserRow {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = userFrom(token);
  if (!user) throw new HttpError(401, 'Your session has expired. Reload the page to start a new one.');
  return user;
}

function snapshot(): PricesEvent {
  const now = Date.now();
  const assets: PricesEvent['assets'] = {};
  for (const [sym, m] of markets) assets[sym] = { price: m.price, chg24h: m.change24h(now), live: m.live(now) };
  return { t: now, assets, pool: poolInfo() };
}

function curvesSnapshot(): CurvesEvent {
  const now = Date.now();
  return {
    t: now,
    series: liveSeries(now).map(s => ({
      key: optSeriesKey(s.expiry), sym: s.sym, venue: s.venue, expiry: s.expiry, open: s.open,
      curve: s.curve, book: publicBook(bookFor(s.venue, s.sym, s.expiry, s.curve)),
    })),
  };
}

/** Everything the Desk page shows: Phase 0 spread stats, and the Phase 2 book and shadow hedger per series. */
function desk() {
  const now = Date.now();
  const series = liveSeries(now).map(s => {
    const d = bookFor(s.venue, s.sym, s.expiry, s.curve);
    const liabValue = d.bets.reduce((a, b) => {
      if (b.wl <= 0) return a + (b.payout / 100) * rangeFair(s.curve, b.side, b.lo, b.hi);
      const shape = rangeShape(s.curve.strikes, b.lo, b.hi);
      return a + (b.payout / 100) * (shape ? rangeValue(s.curve, shape, b.side) : b.prob);
    }, 0);
    const positions = d.positions.map(p => {
      const mark = p.type === 'PERP' ? s.chain.fwd : (quoteAt(s.chain, p.strike, p.type)?.mark ?? 0);
      return { instrument: p.instrument, type: p.type, strike: p.strike, qty: p.qty, cost: p.cost, mark, value: p.qty * mark };
    });
    // Hedge P&L at marks: value now minus what was paid, less fees. (A perp's "value" is its notional, so the raw
    // sum would be dominated by it; its entry cost sits in cash.)
    const hedgePnl = positions.reduce((a, p) => a + p.value - p.cost, 0) - d.fees;
    const hedgeValue = positions.reduce((a, p) => a + p.value, 0);
    return {
      sym: s.sym, venue: s.venue, expiry: s.expiry, open: s.open, fwd: s.curve.fwd, atmIv: s.curve.atmIv,
      grid: d.grid, liab: d.liab, hedge: d.hedge, cash: d.cash, limit: d.limit,
      bets: d.bets.length, stakes: d.stakes, fees: d.fees, slippage: d.slippage,
      worstHedged: d.worstHedged, worstUnhedged: d.worstUnhedged,
      liabValue, hedgePnl, pnl: d.cash + hedgeValue - liabValue,
      positions,
    };
  });
  return {
    t: now,
    riskLimit: config.riskLimit,
    spreads: spreadSummary(now - 24 * 3_600_000),
    series,
    fills: q.recentFills.all(),
    results: q.results.all(),
  };
}

/* ---------- live stream (SSE) ---------- */

const streams = new Set<{ res: ServerResponse; userId: string | null }>();

function streamTo(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function notifyAccount(userId: string) {
  for (const s of streams) if (s.userId === userId) streamTo(s.res, 'account', { t: Date.now() });
}

setInterval(() => {
  if (!streams.size) return;
  const snap = snapshot();
  for (const s of streams) streamTo(s.res, 'prices', snap);
}, 500).unref();

/** Curves and books go out every few seconds, and soon after any bet changes a book. */
let curvesDue = false;
function pushCurves() {
  curvesDue = false;
  if (!streams.size) return;
  const snap = curvesSnapshot();
  for (const s of streams) streamTo(s.res, 'curves', snap);
}
const bookChanged = () => {
  if (!curvesDue) { curvesDue = true; setTimeout(pushCurves, 300); }
};
setInterval(pushCurves, 5000).unref();

/* ---------- API ---------- */

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/markets') {
    const now = Date.now();
    const body: MarketsResponse = {
      serverTime: now,
      fee: FEE,
      cutoffMs: CUTOFF_MS,
      series: SERIES,
      pool: poolInfo(),
      assets: ASSETS.map(a => {
        const m = markets.get(a.sym)!;
        return { sym: a.sym, name: a.name, dec: a.dec, vol: a.vol, source: m.source, price: m.price, chg24h: m.change24h(now), live: m.live(now) };
      }),
    };
    return send(res, 200, body);
  }

  if (route === 'GET /api/opt') return send(res, 200, curvesSnapshot());

  if (route === 'GET /api/desk') return send(res, 200, desk());

  if (route === 'GET /api/candles') {
    const m = markets.get(url.searchParams.get('sym') ?? '');
    const gran = Number(url.searchParams.get('gran'));
    if (!m) throw new HttpError(400, 'Unknown market.');
    if (!GRANS.includes(gran)) throw new HttpError(400, `gran must be one of ${GRANS.join(', ')}.`);
    return send(res, 200, m.candles(gran));
  }

  if (route === 'GET /api/stream') {
    const user = userFrom(url.searchParams.get('token'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const s = { res, userId: user?.id ?? null };
    streams.add(s);
    streamTo(res, 'prices', snapshot());
    streamTo(res, 'curves', curvesSnapshot());
    req.on('close', () => streams.delete(s));
    return;
  }

  if (route === 'POST /api/session') {
    const user = createUser();
    return send(res, 201, { token: user.token, account: account(user.id) });
  }

  if (route === 'GET /api/me') return send(res, 200, account(requireUser(req).id));

  if (route === 'POST /api/me/reset') {
    const user = requireUser(req);
    resetAccount(user.id);
    return send(res, 200, account(user.id));
  }

  if (route === 'POST /api/bets') {
    const user = requireUser(req);
    const bet = placeBet(user.id, parsePlace(await readJson(req)));
    if (bet.kind === 'opt') bookChanged();
    return send(res, 201, { bet, account: account(user.id) });
  }

  const close = route.match(/^POST \/api\/bets\/(\d+)\/close$/);
  if (close) {
    const user = requireUser(req);
    const body = await readJson(req);
    const minValue = typeof body.minValue === 'number' ? body.minValue : undefined;
    const bet = closeBet(user.id, Number(close[1]), minValue);
    if (bet.kind === 'opt') bookChanged();
    return send(res, 200, { bet, account: account(user.id) });
  }

  if (route === 'GET /api/recent') {
    const rows = q.recentBets.all() as { id: number; sym: string; side: string; lo: number; hi: number; mult: number; stake: number; kind: string; created_at: number }[];
    return send(res, 200, rows.map(r => ({ id: r.id, sym: r.sym, side: r.side, lo: r.lo, hi: r.hi, mult: r.mult, stake: r.stake / 100, kind: r.kind, t: r.created_at })));
  }

  if (route === 'GET /api/leaderboard') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return send(res, 200, leaderboard(userFrom(token)?.id ?? null));
  }

  throw new HttpError(404, 'Not found.');
}

/* ---------- static files (production) ---------- */

const DIST = resolve('dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

function serveStatic(res: ServerResponse, pathname: string) {
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) return send(res, 400, { error: 'Bad path.' });
  if (!existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');
  if (!existsSync(file)) return send(res, 404, { error: 'Run `pnpm build` first.' });
  const immutable = file.includes(`${DIST}/assets/`);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

/* ---------- boot ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (config.prod) return serveStatic(res, url.pathname);
    send(res, 404, { error: 'In development, open the Vite dev server instead.' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

console.log('[boot] loading price history…');
await startFeeds();
if (!config.optOff) {
  console.log('[boot] loading option chains…');
  await startOptionFeeds();
  startResearch();
  startHedger();
}
setInterval(() => {
  try { settleDue(notifyAccount); } catch (e) { console.error('[settle]', e); }
}, 500).unref();

server.listen(config.port, () => console.log(`[boot] Bracket API on http://localhost:${config.port}`));

function shutdown() {
  saveSimState();
  server.close();
  for (const s of streams) s.res.end();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
