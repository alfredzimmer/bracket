import { useCallback, useEffect, useRef, useState } from 'react';
import { SERIES, nextExpiry } from '../shared/markets.ts';
import { OPT_FEE, densityFn, inRangeOfStrikes, probBelowFn, rangeFair, rangeQuote } from '../shared/options.ts';
import { FEE, ladderStep, quote, sigma } from '../shared/pricing.ts';
import type { Account, OptSeriesInfo, Side } from '../shared/types.ts';
import { api } from './api.ts';
import { Chart } from './components/Chart.tsx';
import { Desk } from './components/Desk.tsx';
import { Landing, PENDING_KEY, type PendingRange } from './components/Landing.tsx';
import { TopNav, type View, Wordmark, viewFromHash } from './components/Nav.tsx';
import { Ladder, modelRows, rangeRows } from './components/Ladder.tsx';
import { Positions, seriesLabel } from './components/Positions.tsx';
import { Ticket, type TicketQuote } from './components/Ticket.tsx';
import { compactUsd, decimalsFor, dur, fmtPx, fmtWhen, pct, signedPct, usd } from './format.ts';
import { type BracketState, useBracket, useCandles } from './hooks.ts';

interface Toast { id: number; msg: string; kind: 'ok' | 'err' }

const VENUE_NAME: Record<string, string> = { derive: 'Derive', hypercall: 'Hypercall' };
const H = 3_600_000;

export function App() {
  const b = useBracket();
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const on = () => setView(viewFromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  if (view === 'landing') return <Landing b={b} />;
  if (view === 'desk') return <Desk />;
  if (!b.markets || !b.account) {
    return (
      <div className="boot">
        <Wordmark />
        <p>{b.bootError ? `${b.bootError} Retrying…` : 'Loading markets…'}</p>
      </div>
    );
  }
  return <Terminal b={b} account={b.account} />;
}

/** First options-backed expiry at least 12 hours out (falls back to the first one), else the daily practice series. */
function defaultSeries(opt: OptSeriesInfo[], sym: string, now: number): string {
  const mine = opt.filter(s => s.sym === sym && s.open);
  return (mine.find(s => s.expiry - now > 12 * H) ?? mine[0])?.key ?? '1d';
}

/** Chart candle size for an options-backed expiry, matched to how far away it is. */
function granFor(msLeft: number): number {
  return msLeft < 6 * H ? 60 : msLeft < 24 * H ? 300 : msLeft < 4 * 24 * H ? 900 : msLeft < 14 * 24 * H ? 3600 : 21600;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dayMonth = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** "Today", "Tomorrow", a weekday within the week, else "Fri, 27 Nov". */
function whenLabel(ts: number, now: number): string {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000);
  const d = day(ts) - day(now);
  return d <= 0 ? 'Today' : d === 1 ? 'Tomorrow' : d < 7 ? weekday.format(ts) : dayMonth.format(ts);
}

/** A range chosen on the landing page, consumed once. */
function takePending(): PendingRange | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingRange) : null;
  } catch {
    return null;
  }
}

function Terminal({ b, account }: { b: BracketState; account: Account }) {
  const [pending] = useState(takePending);
  const pendingUsed = useRef(false);
  const [sym, setSym] = useState(pending?.sym ?? 'BTC');
  const [seriesKey, setSeriesKey] = useState(() => pending?.series ?? defaultSeries(b.opt, 'BTC', b.now));
  const [side, setSide] = useState<Side>('in');
  const [range, setRange] = useState<{ lo: number; hi: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showPractice, setShowPractice] = useState(false);
  const toastId = useRef(0);

  const asset = b.assets.find(a => a.sym === sym)!;
  const now = b.now;
  const optList = b.opt.filter(s => s.sym === sym);
  const optS = optList.find(s => s.key === seriesKey);
  const practice = SERIES.find(s => s.key === seriesKey);
  const curve = optS?.curve;

  // Options-backed expiries come and go; fall back when the selected one disappears.
  useEffect(() => {
    if (!optS && !practice) setSeriesKey(defaultSeries(b.opt, sym, now));
  }, [optS, practice, b.opt, sym, now]);

  const expiresAt = optS ? optS.expiry : nextExpiry(practice?.key ?? '1d', now);
  const msLeft = expiresAt - now;
  const vol = curve ? curve.atmIv : asset.vol;
  const gran = practice ? practice.gran : granFor(msLeft);
  const center = curve ? curve.fwd : asset.price;
  const step = center > 0 ? ladderStep(center, vol, msLeft) : 1;
  const tick = step / 10;
  const rdec = Math.max(asset.dec, decimalsFor(tick));
  const candles = useCandles(sym, gran, asset.price, now);

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    const id = ++toastId.current;
    setToasts(t => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);

  /** Options-backed ranges can be anything the listed strikes can cover. */
  const snap = useCallback((l: number, h: number) => {
    if (!curve) return { lo: l, hi: h };
    const min = curve.strikes[1], max = curve.strikes[curve.strikes.length - 2];
    const lo = Math.min(Math.max(l, min), max - tick);
    const hi = Math.max(Math.min(h, max), lo + tick);
    return { lo: Number(lo.toFixed(rdec)), hi: Number(hi.toFixed(rdec)) };
  }, [curve, tick, rdec]);
  const setSnapped = (l: number, h: number) => setRange(snap(l, h));

  // Start each market with a range around the price: three ladder rows, price in the middle one.
  useEffect(() => setRange(null), [sym, seriesKey]);
  useEffect(() => {
    if (range || !(center > 0)) return;
    if (pending && !pendingUsed.current && pending.sym === sym && pending.series === seriesKey) {
      pendingUsed.current = true;
      setRange(snap(pending.lo, pending.hi));
      return;
    }
    const lo = Number((Math.floor(center / step) * step - step).toFixed(rdec));
    setRange(snap(lo, Number((lo + 3 * step).toFixed(rdec))));
  }, [range, center, step, rdec, snap, pending, sym, seriesKey]);

  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const pickSym = (s: string) => {
    setSym(s);
    setSeriesKey(defaultSeries(b.opt, s, now));
  };

  const onAccount = (a: Account, msg: string) => { b.setAccount(a); toast(msg); };
  const reset = async () => {
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    try { onAccount(await api.reset(), 'Account reset to the starting balance.'); }
    catch (e) { toast((e as Error).message, 'err'); }
  };

  const price = (sd: Side, l: number, h: number, stake: number): TicketQuote => {
    if (optS) {
      if (!optS.open) return { ok: false, prob: 0, reason: msLeft <= 30 * 60_000 ? 'Betting on this expiry has closed for its 30-minute settlement window.' : 'Option quotes are stale. Betting resumes when they update.' };
      return rangeQuote({ curve: optS.curve, book: optS.book, side: sd, lo: l, hi: h, stake });
    }
    return quote({ side: sd, spot: asset.price, vol: asset.vol, msLeft, lo: l, hi: h });
  };

  const lo = range?.lo ?? 0, hi = range?.hi ?? 0;
  const qt = range ? price(side, lo, hi, 0) : null;
  const chartLabel = qt ? `${side === 'in' ? 'Inside' : 'Outside'} · ${pct(qt.prob)}${qt.ok ? ` · ${qt.mult.toFixed(2)}×` : ''}` : '';
  const pool = b.pool;
  const util = pool && pool.balance > 0 ? pool.liability / pool.balance : 0;
  const sig = sigma(vol, msLeft);
  const venue = optS ? VENUE_NAME[optS.venue] : '';
  const rows = curve
    ? rangeRows(curve.fwd, step, rdec, (l, h) => (inRangeOfStrikes(curve, l, h) ? rangeFair(curve, 'in', l, h) : null))
    : modelRows(asset.price, asset.vol, msLeft, step, rdec);

  return (
    <div className="app">
      <TopNav
        active="trade"
        right={<>
          <span className="badge">Paper</span>
          <span className="who">{account.name}</span>
          <span className="bal">Balance <b className="num">{usd(account.balance)}</b> USDC</span>
          <button className={`ghost${confirmReset ? ' warn' : ''}`} onClick={reset}>{confirmReset ? 'Click again to reset' : 'Reset'}</button>
        </>}
      />

      {b.offline && <div className="banner">Live prices disconnected. Reconnecting… Betting is paused until prices resume.</div>}

      <nav className="assets" aria-label="Markets">
        {b.assets.map(a => (
          <button key={a.sym} className={`asset${a.sym === sym ? ' on' : ''}`} onClick={() => pickSym(a.sym)}>
            <b>{a.sym}</b>
            <span className="num">{a.price > 0 ? fmtPx(a.price, a.dec) : '—'}</span>
            <span className={`num ${a.chg24h >= 0 ? 'up' : 'down'}`}>{signedPct(a.chg24h)}</span>
          </button>
        ))}
      </nav>

      <section className="mkt">
        <div className="sym">
          <b>{asset.sym}</b>
          <span className="px num">{fmtPx(asset.price, asset.dec)}</span>
          <span className={`chg num ${asset.chg24h >= 0 ? 'up' : 'down'}`}>{signedPct(asset.chg24h)}</span>
        </div>
        <div className="statbar">
          <div className="stat">
            <span className="k" title={curve ? `From ${venue}'s ${asset.sym} options for this date` : 'Annualized volatility used to price ranges'}>Implied vol</span>
            <span className="v num">{(vol * 100).toFixed(0)}%</span>
          </div>
          <div className="stat"><span className="k" title="One standard deviation move by settlement">1σ move</span><span className="v num">±{fmtPx(asset.price * sig, asset.dec)}</span></div>
          <div className="stat"><span className="k" title="House pool that pays winning bets. Utilization is open payouts over pool size.">Pool</span><span className="v num">{pool ? `${compactUsd(pool.balance)} · ${(util * 100).toFixed(1)}%` : '—'}</span></div>
          <div className={`stat live${asset.live ? '' : ' off'}`} title={asset.source === 'coinbase' ? 'Spot from Coinbase' : 'Simulated market'}>{asset.live ? (asset.source === 'coinbase' ? 'Live' : 'Sim') : 'Offline'}</div>
        </div>
        <div className="exp">
          {optList.length > 0 && (
            <div className="seg" role="radiogroup" aria-label="Settlement date">
              <span className="seg-k">Settles</span>
              {optList.map(s => (
                <button key={s.key} role="radio" aria-checked={s.key === seriesKey} className={`${s.key === seriesKey ? 'on' : ''}${s.open ? '' : ' shut'}`} onClick={() => setSeriesKey(s.key)} title={fmtWhen(s.expiry)}>
                  {whenLabel(s.expiry, now)}
                </button>
              ))}
            </div>
          )}
          {optList.length > 0 && !showPractice && !practice
            ? <button className="more" onClick={() => setShowPractice(true)} title="Hourly to monthly practice markets, priced by a simple model">Practice markets</button>
            : (
              <div className="seg" role="radiogroup" aria-label="Practice expiry" title="Practice expiries: priced by a flat-vol model, settled on Coinbase">
                <span className="seg-k">Practice</span>
                {SERIES.map(s => (
                  <button key={s.key} role="radio" aria-checked={s.key === seriesKey} className={s.key === seriesKey ? 'on' : ''} onClick={() => setSeriesKey(s.key)}>{s.label}</button>
                ))}
              </div>
            )}
          <span className="num muted settle">Settles {fmtWhen(expiresAt)} · in {dur(msLeft)}</span>
        </div>
      </section>

      <main className="main">
        <section className="chart-wrap">
          <div className="panel-h chart-h">
            <b>{asset.sym} · range to settlement</b>
            <div className="legend">
              <span><i className={`sw ${side}`} />Your range</span>
              <span><i className="sw cone" />1σ / 2σ cone</span>
              <span title={curve ? `Implied by ${venue}'s option prices` : 'From the pricing model'}><i className="sw dist" />Where it settles</span>
            </div>
          </div>
          {range && (
            <Chart
              candles={candles} gran={gran} spot={asset.price} vol={vol} now={now} expiresAt={expiresAt}
              lo={lo} hi={hi} side={side} rdec={rdec} tick={tick} label={chartLabel}
              onRange={setSnapped}
              densityAt={curve ? densityFn(curve) : undefined}
              probBelowAt={curve ? probBelowFn(curve) : undefined}
            />
          )}
          <div className="hint">Drag up or down on the chart to draw a range. Drag its edges to adjust.</div>
        </section>

        {range && (
          <Ladder
            rows={rows} note={`${fmtPx(step, rdec)} per row`} spot={center} rdec={rdec}
            lo={lo} hi={hi} fee={curve ? OPT_FEE : FEE}
            chanceTitle={curve ? `Chance of settling in the row, implied by ${venue}'s options` : 'Model chance of settling in the row'}
            onPick={(l, h, extend) => setSnapped(extend ? Math.min(lo, l) : l, extend ? Math.max(hi, h) : h)}
          />
        )}

        {range && (
          <Ticket
            asset={asset} seriesKey={seriesKey} seriesLabel={optS ? seriesLabel(seriesKey) : practice?.label ?? ''}
            price={price} opt={curve ? { venue } : undefined}
            now={now} expiresAt={expiresAt} side={side} onSide={setSide}
            lo={lo} hi={hi} onRange={setSnapped} step={step} tick={tick} rdec={rdec}
            balance={account.balance} onPlaced={onAccount}
          />
        )}
      </main>

      <Positions account={account} assets={b.assets} opt={b.opt} now={now} onAccount={onAccount} onError={m => toast(m, 'err')} />

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </div>
  );
}
