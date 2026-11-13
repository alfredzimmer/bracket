import { useCallback, useEffect, useRef } from 'react';
import { density, niceStep, probBelow, sigma } from '../../shared/pricing.ts';
import type { Candle, Side } from '../../shared/types.ts';
import { decimalsFor, fmtPx, pct, snapTo } from '../format.ts';

export interface ChartProps {
  candles: Candle[];
  gran: number;
  spot: number;
  vol: number;
  now: number;
  expiresAt: number;
  lo: number;
  hi: number;
  side: Side;
  /** Decimals for range prices. */
  rdec: number;
  tick: number;
  label: string;
  onRange: (lo: number, hi: number) => void;
  /** Settlement density to draw instead of the lognormal model (options-backed expiries use the market-implied one). */
  densityAt?: (p: number) => number;
  probBelowAt?: (p: number) => number;
  /** Partial-payout zones below lo and above hi. */
  ramps?: { wl: number; wh: number };
}

const AXIS_W = 78, PAD_T = 14, PAD_B = 26, HANDLE = 9;
const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800].map(s => s * 1000);

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function Chart(props: ChartProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const geom = useRef<{ y: (p: number) => number; inv: (y: number) => number } | null>(null);
  const hoverY = useRef<number | null>(null);
  const drag = useRef<{ k: 'lo' | 'hi' } | { k: 'new'; anchor: number } | null>(null);

  const draw = useCallback(() => {
    const cv = canvas.current;
    if (!cv) return;
    const { candles, gran, spot, vol, now, expiresAt, lo, hi, side, rdec, label, densityAt, ramps } = latest.current;
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!(spot > 0) || W < 50) return;

    const css = getComputedStyle(cv);
    const C = {
      acc: css.getPropertyValue('--accent').trim(), ink: css.getPropertyValue('--accent-ink').trim(),
      up: css.getPropertyValue('--up').trim(), dn: css.getPropertyValue('--down').trim(), dnInk: css.getPropertyValue('--down-ink').trim(),
      line: css.getPropertyValue('--line').trim(), mut: css.getPropertyValue('--muted').trim(), dim: css.getPropertyValue('--dim').trim(),
      fg: css.getPropertyValue('--fg').trim(), bg: css.getPropertyValue('--bg').trim(), panel: css.getPropertyValue('--panel').trim(),
    };
    const mono = css.getPropertyValue('--mono').trim(), sans = css.getPropertyValue('--sans').trim();

    const pw = W - AXIS_W, ph = H - PAD_T - PAD_B, xe = pw - 8;
    const left = Math.max(expiresAt - now, 1000);
    const histSpan = Math.max(2 * left, 60 * gran * 1000);
    const t0 = now - histSpan;
    const x = (t: number) => ((t - t0) / (expiresAt - t0)) * xe;
    const xNow = x(now);
    const s = sigma(vol, left);
    const dens = densityAt ?? ((p: number) => density(spot, p, s));

    const visible = candles.filter(c => (c.t + gran) * 1000 > t0);
    let yLo = Math.min(spot * Math.exp(-2.3 * s), lo - (ramps?.wl ?? 0), ...visible.map(c => c.l));
    let yHi = Math.max(spot * Math.exp(2.3 * s), hi + (ramps?.wh ?? 0), ...visible.map(c => c.h));
    const pad = (yHi - yLo) * 0.05;
    yLo -= pad; yHi += pad;
    const y = (p: number) => PAD_T + ((yHi - p) / (yHi - yLo)) * ph;
    geom.current = { y, inv: v => yHi - ((v - PAD_T) / ph) * (yHi - yLo) };

    ctx.font = `11px ${mono}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    // Price grid
    const gs = niceStep((yHi - yLo) / 6);
    const gdec = decimalsFor(gs);
    ctx.strokeStyle = C.line;
    ctx.fillStyle = C.dim;
    for (let g = Math.ceil(yLo / gs) * gs; g <= yHi; g += gs) {
      const yy = Math.round(y(g)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke();
      ctx.fillText(fmtPx(g, gdec), pw + 8, yy);
    }

    // Time axis
    const step = TIME_STEPS.find(st => (expiresAt - t0) / st <= 6) ?? TIME_STEPS.at(-1)!;
    const tf = new Intl.DateTimeFormat(undefined, step >= 86_400_000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
    ctx.textBaseline = 'alphabetic';
    const tzOff = new Date(now).getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((t0 - tzOff) / step) * step + tzOff; t < expiresAt; t += step) {
      const xx = x(t);
      if (xx < 24 || Math.abs(xx - xNow) < 72 || xe - xx < 70) continue;
      ctx.fillStyle = C.dim;
      ctx.fillText(tf.format(t), xx - 16, H - 8);
    }

    // Future zone
    ctx.fillStyle = rgba(C.panel, 0.6);
    ctx.fillRect(xNow, PAD_T, xe - xNow, ph);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = C.dim;
    for (const xx of [xNow, xe]) { ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, PAD_T); ctx.lineTo(Math.round(xx) + 0.5, PAD_T + ph); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = C.mut;
    const expLabel = 'settles';
    const expW = ctx.measureText(expLabel).width;
    if (xe - xNow > expW + 40) ctx.fillText('now', xNow + 4, H - 8);
    ctx.fillText(expLabel, xe - expW - 4, H - 8);
    ctx.textBaseline = 'middle';

    // 1σ / 2σ cone
    for (const k of [2, 1]) {
      ctx.beginPath();
      const n = 40;
      for (let i = 0; i <= n; i++) { const f = i / n; ctx.lineTo(xNow + (xe - xNow) * f, y(spot * Math.exp(k * s * Math.sqrt(f)))); }
      for (let i = n; i >= 0; i--) { const f = i / n; ctx.lineTo(xNow + (xe - xNow) * f, y(spot * Math.exp(-k * s * Math.sqrt(f)))); }
      ctx.fillStyle = rgba(C.mut, k === 2 ? 0.06 : 0.09);
      ctx.fill();
    }

    // Range band
    const out = side === 'out';
    const bc = out ? C.dn : C.acc, bInk = out ? C.dnInk : C.ink;
    const yU = y(hi), yL = y(lo);
    if (!out) {
      ctx.fillStyle = rgba(C.acc, 0.14);
      ctx.fillRect(xNow, yU, xe - xNow, yL - yU);
    } else {
      // With partial zones, full payout for "outside" only starts beyond them.
      const yTop = ramps ? y(hi + ramps.wh) : yU, yBot = ramps ? y(lo - ramps.wl) : yL;
      ctx.fillStyle = rgba(C.dn, 0.1);
      ctx.fillRect(xNow, PAD_T, xe - xNow, Math.max(0, yTop - PAD_T));
      ctx.fillRect(xNow, yBot, xe - xNow, Math.max(0, PAD_T + ph - yBot));
    }
    if (ramps) {
      // Partial-payout zones: shade fades from the payout at the edge (full for "in", none for "out") to the
      // payout at the outer strike (none for "in", full for "out").
      const full = rgba(bc, out ? 0.1 : 0.14), none = rgba(bc, 0);
      for (const [edge, outer] of [[lo, lo - ramps.wl], [hi, hi + ramps.wh]]) {
        const g = ctx.createLinearGradient(0, y(edge), 0, y(outer));
        g.addColorStop(0, out ? none : full);
        g.addColorStop(1, out ? full : none);
        ctx.fillStyle = g;
        ctx.fillRect(xNow, Math.min(y(edge), y(outer)), xe - xNow, Math.abs(y(outer) - y(edge)));
      }
      ctx.strokeStyle = rgba(bc, 0.3);
      ctx.setLineDash([1, 3]);
      for (const v of [lo - ramps.wl, hi + ramps.wh]) { ctx.beginPath(); ctx.moveTo(xNow, y(v)); ctx.lineTo(pw, y(v)); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = rgba(bc, 0.35);
    ctx.setLineDash([4, 4]);
    for (const v of [yU, yL]) { ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(xNow, v); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.strokeStyle = bc;
    ctx.lineWidth = 1.5;
    for (const v of [yU, yL]) { ctx.beginPath(); ctx.moveTo(xNow, v); ctx.lineTo(pw, v); ctx.stroke(); }
    ctx.lineWidth = 1;
    ctx.fillStyle = bc;
    for (const v of [yU, yL]) ctx.fillRect(xNow - 4, v - 4, 8, 8);

    // Settlement distribution, drawn leftward from the expiry line
    const n = 160, wmax = Math.min((xe - xNow) * 0.55, 220);
    const pts: [number, number][] = [];
    let fmax = 0;
    for (let i = 0; i <= n; i++) {
      const p = yLo + ((yHi - yLo) * i) / n;
      const f = p > 0 ? dens(p) : 0;
      pts.push([p, f]);
      fmax = Math.max(fmax, f);
    }
    const xOf = (f: number) => xe - (f / (fmax || 1)) * wmax;
    const fill = (a: number, b: number, col: string) => {
      if (b <= a) return;
      ctx.beginPath();
      ctx.moveTo(xe, y(a));
      ctx.lineTo(xOf(dens(a)), y(a));
      for (const [p, f] of pts) if (p > a && p < b) ctx.lineTo(xOf(f), y(p));
      ctx.lineTo(xOf(dens(b)), y(b));
      ctx.lineTo(xe, y(b));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    };
    const winCol = rgba(bc, out ? 0.22 : 0.26), loseCol = rgba(C.mut, 0.1);
    const cLo = Math.max(yLo, lo), cHi = Math.min(yHi, hi);
    fill(Math.max(yLo, 1e-9), cLo, out ? winCol : loseCol);
    fill(cLo, cHi, out ? loseCol : winCol);
    fill(cHi, yHi, out ? winCol : loseCol);
    ctx.beginPath();
    pts.forEach(([p, f], i) => (i ? ctx.lineTo(xOf(f), y(p)) : ctx.moveTo(xOf(f), y(p))));
    ctx.strokeStyle = rgba(C.fg, 0.45);
    ctx.stroke();

    // Price as a line with a soft fill beneath it
    const line = visible.map(c => [x((c.t + gran / 2) * 1000), y(c.c)] as const);
    if (line.length) {
      line.push([xNow, y(spot)]);
      ctx.beginPath();
      line.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.lineTo(xNow, PAD_T + ph);
      ctx.lineTo(line[0][0], PAD_T + ph);
      ctx.closePath();
      ctx.fillStyle = rgba(C.fg, 0.045);
      ctx.fill();
      ctx.beginPath();
      line.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.strokeStyle = C.fg;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = C.fg;
      ctx.beginPath(); ctx.arc(xNow, y(spot), 3.2, 0, Math.PI * 2); ctx.fill();
    }

    // Mark line
    const ys = y(spot);
    ctx.strokeStyle = rgba(C.fg, 0.45);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, ys); ctx.lineTo(pw, ys); ctx.stroke();
    ctx.setLineDash([]);

    // Quote tag on the band
    ctx.font = `600 12px ${sans}`;
    const tw = ctx.measureText(label).width + 14;
    const ly = out ? Math.max(PAD_T + 12, yU - 14) : Math.min(Math.max((yU + yL) / 2, yU + 12), yL - 12);
    const lx = Math.min(xNow + 10, pw - tw - 4);
    ctx.fillStyle = bc;
    roundRect(ctx, lx, ly - 10, tw, 20, 4); ctx.fill();
    ctx.fillStyle = bInk;
    ctx.fillText(label, lx + 7, ly + 1);

    // Axis tags
    ctx.font = `11px ${mono}`;
    const tag = (v: number, bg: string, fg: string, dec = rdec) => {
      const yy = y(v);
      ctx.fillStyle = bg;
      roundRect(ctx, pw + 2, yy - 9, AXIS_W - 4, 18, 3); ctx.fill();
      ctx.fillStyle = fg;
      ctx.fillText(fmtPx(v, dec), pw + 8, yy + 1);
    };
    tag(hi, bc, bInk);
    tag(lo, bc, bInk);
    tag(spot, C.fg, C.bg);

    // Hover crosshair with the chance of settling beyond it
    const hy = hoverY.current;
    if (hy != null && hy > PAD_T && hy < PAD_T + ph && !drag.current) {
      const hv = geom.current.inv(hy);
      ctx.strokeStyle = rgba(C.mut, 0.5);
      ctx.beginPath(); ctx.moveTo(0, Math.round(hy) + 0.5); ctx.lineTo(pw, Math.round(hy) + 0.5); ctx.stroke();
      tag(hv, C.fg, C.bg);
      const pb = latest.current.probBelowAt;
      const below = pb ? pb(hv) : probBelow(spot, hv, s);
      ctx.fillStyle = C.mut;
      ctx.fillText(hv > spot ? `settles above: ${pct(1 - below)}` : `settles below: ${pct(below)}`, 8, hy - 10);
    }
  }, []);

  useEffect(() => { draw(); });
  useEffect(() => {
    const ro = new ResizeObserver(draw);
    ro.observe(canvas.current!);
    return () => ro.disconnect();
  }, [draw]);

  const relY = (e: React.PointerEvent) => e.clientY - canvas.current!.getBoundingClientRect().top;
  const near = (yy: number, p: number) => geom.current != null && Math.abs(yy - geom.current.y(p)) < HANDLE;

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!geom.current) return;
    const { lo, hi, tick, rdec } = latest.current;
    const yy = relY(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (near(yy, hi)) drag.current = { k: 'hi' };
    else if (near(yy, lo)) drag.current = { k: 'lo' };
    else drag.current = { k: 'new', anchor: snapTo(geom.current.inv(yy), tick, rdec) };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!geom.current) return;
    const { lo, hi, tick, rdec, onRange } = latest.current;
    const yy = relY(e);
    hoverY.current = yy;
    const v = Math.max(tick, snapTo(geom.current.inv(yy), tick, rdec));
    const d = drag.current;
    if (d?.k === 'hi') onRange(lo, Math.max(lo + tick, v));
    else if (d?.k === 'lo') onRange(Math.min(hi - tick, v), hi);
    else if (d?.k === 'new') onRange(Math.min(d.anchor, v), Math.max(v === d.anchor ? d.anchor + tick : d.anchor, v));
    e.currentTarget.style.cursor = d || near(yy, hi) || near(yy, lo) ? 'ns-resize' : 'crosshair';
    if (!d) draw();
  };
  const onUp = () => { drag.current = null; };
  const onLeave = () => { hoverY.current = null; draw(); };

  return (
    <canvas
      ref={canvas}
      className="chart"
      aria-label="Price chart. Drag vertically to set the range you are betting on."
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onLeave}
    />
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
