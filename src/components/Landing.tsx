import { useEffect, useRef, useState } from 'react';
import { densityFn, inRangeOfStrikes, rangeQuote } from '../../shared/options.ts';
import { niceStep } from '../../shared/pricing.ts';
import type { OptSeriesInfo } from '../../shared/types.ts';
import { fmtPx, fmtWhen, pct, signedPct, usd } from '../format.ts';
import type { BracketState } from '../hooks.ts';
import { Wordmark } from './Nav.tsx';

const YEAR_MS = 365 * 24 * 3_600_000;
const H = 3_600_000;
export const PENDING_KEY = 'bracket.pending';

/** A range picked on the landing page, handed to the terminal. */
export interface PendingRange { sym: string; series: string; lo: number; hi: number }

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * The hero: BTC's settlement distribution for one expiry, implied by Derive's options. Drag the braces to set a range
 * and the quote updates live, priced exactly as the terminal prices it.
 */
function RangeHero({ series, now }: { series: OptSeriesInfo[]; now: number }) {
  const [key, setKey] = useState(() => (series.find(s => s.expiry - now > 2 * 24 * H) ?? series[0]).key);
  const s = series.find(x => x.key === key) ?? series[0];
  const c = s.curve;
  const sd = c.fwd * c.atmIv * Math.sqrt(Math.max(s.expiry - now, 60_000) / YEAR_MS);
  const step = niceStep(sd / 8);
  const snap = (v: number) => Math.round(v / step) * step;
  const [range, setRange] = useState<{ lo: number; hi: number } | null>(null);
  useEffect(() => setRange(null), [key]);
  const lo = range?.lo ?? snap(c.fwd - sd * 0.5), hi = range?.hi ?? snap(c.fwd + sd * 0.5);

  const W = 1000, PH = 230, BASE = 210;
  const x0 = c.fwd - 3 * sd, x1 = c.fwd + 3 * sd;
  const X = (v: number) => ((v - x0) / (x1 - x0)) * W;
  const inv = (px: number) => x0 + (px / W) * (x1 - x0);
  const dens = densityFn(c);
  const N = 160;
  const xs = Array.from({ length: N + 1 }, (_, i) => x0 + ((x1 - x0) * i) / N);
  const fmax = Math.max(...xs.map(dens), 1e-12);
  const Y = (v: number) => BASE - (dens(v) / fmax) * 175;
  const area = (a: number, b: number) => {
    const pts = [a, ...xs.filter(v => v > a && v < b), b];
    return `M${X(a)},${BASE} ${pts.map(v => `L${X(v).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')} L${X(b)},${BASE} Z`;
  };
  const ok = inRangeOfStrikes(c, lo, hi);
  const q = ok ? rangeQuote({ curve: c, book: s.book, side: 'in', lo, hi, stake: 100 }) : null;

  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<'lo' | 'hi' | null>(null);
  const toX = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * W;
  };
  const onDown = (e: React.PointerEvent) => {
    const px = toX(e);
    drag.current = Math.abs(px - X(lo)) < Math.abs(px - X(hi)) ? 'lo' : 'hi';
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const v = snap(inv(toX(e)));
    if (drag.current === 'lo') setRange({ lo: Math.min(v, hi - step), hi });
    else setRange({ lo, hi: Math.max(v, lo + step) });
  };
  const nudge = (which: 'lo' | 'hi', d: number) =>
    setRange(which === 'lo' ? { lo: Math.min(lo + d * step, hi - step), hi } : { lo, hi: Math.max(hi + d * step, lo + step) });

  const go = () => {
    const p: PendingRange = { sym: 'BTC', series: s.key, lo, hi };
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {}
    location.hash = '#trade';
  };

  return (
    <div className="picker">
      <div className="picker-top">
        <div className="exp-pills" role="radiogroup" aria-label="Settlement date">
          {series.slice(0, 6).map(x => (
            <button key={x.key} role="radio" aria-checked={x.key === s.key} className={x.key === s.key ? 'on' : ''} onClick={() => setKey(x.key)}>
              {dayFmt.format(x.expiry)}
            </button>
          ))}
        </div>
        <span className="muted small">BTC now <b className="num">{fmtPx(c.fwd, 0)}</b> · settles {fmtWhen(s.expiry)}</span>
      </div>

      <svg
        ref={svg} viewBox={`0 0 ${W} ${PH}`} preserveAspectRatio="none" className="picker-svg"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        role="img" aria-label={`BTC settlement distribution with the range ${fmtPx(lo, 0)} to ${fmtPx(hi, 0)} selected. Drag to change it.`}
      >
        <path className="pk-dist" d={area(x0, x1)} />
        <path className="pk-in" d={area(Math.max(lo, x0), Math.min(hi, x1))} />
        <line className="pk-now" x1={X(c.fwd)} x2={X(c.fwd)} y1={12} y2={BASE} />
        <line className="pk-base" x1={0} x2={W} y1={BASE} y2={BASE} />
        {[lo, hi].map(v => <line key={v} className="pk-edge" x1={X(v)} x2={X(v)} y1={8} y2={BASE} />)}
      </svg>
      {/* Braces are HTML so they keep their shape while the chart stretches. */}
      <div className="pk-braces" aria-hidden="true">
        <span style={{ left: `${(X(lo) / W) * 100}%` }}>{'{'}</span>
        <span style={{ left: `${(X(hi) / W) * 100}%` }}>{'}'}</span>
      </div>
      <div className="pk-axis num" aria-hidden="true">
        {[-2, -1, 0, 1, 2].map(k => {
          const v = c.fwd + k * sd;
          return <span key={k} style={{ left: `${(X(v) / W) * 100}%` }}>{fmtPx(snap(v), 0)}</span>;
        })}
      </div>

      <div className="picker-foot">
        <div className="pk-range">
          <span className="small muted">BTC settles inside</span>
          <div className="pk-bounds num">
            <button aria-label="Lower the lower bound" onClick={() => nudge('lo', -1)}>−</button>
            <span>{fmtPx(lo, 0)}</span>
            <button aria-label="Raise the lower bound" onClick={() => nudge('lo', 1)}>+</button>
            <span className="muted">–</span>
            <button aria-label="Lower the upper bound" onClick={() => nudge('hi', -1)}>−</button>
            <span>{fmtPx(hi, 0)}</span>
            <button aria-label="Raise the upper bound" onClick={() => nudge('hi', 1)}>+</button>
          </div>
        </div>
        <div className="pk-num"><span className="small muted">Chance</span><b className="num">{q?.ok ? pct(q.prob) : '—'}</b></div>
        <div className="pk-num"><span className="small muted">Pays</span><b className="num accent">{q?.ok ? `${q.mult.toFixed(2)}×` : '—'}</b></div>
        <div className="pk-num"><span className="small muted">$100 returns</span><b className="num">{q?.ok ? `$${usd(100 * q.mult)}` : '—'}</b></div>
        <button className="btn primary" onClick={go} disabled={!q?.ok}>Bet this range →</button>
      </div>
      {q && !q.ok && <p className="small down" style={{ margin: '8px 0 0' }}>{q.reason}</p>}
    </div>
  );
}

export function Landing({ b }: { b: BracketState }) {
  const now = b.now;
  const btc = b.opt.filter(s => s.sym === 'BTC' && s.open);
  const spot = b.assets.find(a => a.sym === 'BTC');

  return (
    <div className="landing">
      <header className="lp-top">
        <Wordmark />
        <nav>
          {spot && spot.price > 0 && (
            <span className="lp-px num">BTC {fmtPx(spot.price, 0)} <span className={spot.chg24h >= 0 ? 'up' : 'down'}>{signedPct(spot.chg24h)}</span></span>
          )}
          <a href="#desk">Desk</a>
          <a className="btn small-btn" href="#trade">Open app</a>
        </nav>
      </header>

      <section className="hero">
        <h1>Bet where bitcoin <em>settles</em>.</h1>
        <p className="lede">
          Draw a range. If BTC's price lands inside it on the date you pick, you get paid. Odds come straight from the options
          market, so you get a fair price without touching an option yourself.
        </p>
        {btc.length
          ? <RangeHero series={btc} now={now} />
          : <div className="picker loading muted">Loading live option prices…</div>}
      </section>

      <footer className="lp-foot">
        <Wordmark />
        <span>Paper trading only. No real money, and no orders are sent to any venue.</span>
        <span>Prices from Coinbase and Derive.</span>
      </footer>
    </div>
  );
}
