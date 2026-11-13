import { probInside, sigma } from '../../shared/pricing.ts';
import { fmtPx, pct } from '../format.ts';

/** p: chance of settling in the row (model or options-implied); null when the row can't be priced. */
export interface LadderRow { l: number; h: number; p: number | null }

interface Props {
  rows: LadderRow[];
  /** Header note, e.g. "250 per row" or "Derive strikes". */
  note: string;
  /** Price marked as "here" (spot, or the forward for options-backed expiries). */
  spot: number;
  rdec: number;
  lo: number;
  hi: number;
  /** Explains the chance column. */
  chanceTitle: string;
  /** Fee taken from payouts, for the multiplier column. */
  fee: number;
  onPick: (lo: number, hi: number, extend: boolean) => void;
}

const ROWS_EACH_SIDE = 9;

/** Evenly spaced rows around `center`, each priced by `prob` (null when it can't be priced). */
export function rangeRows(center: number, step: number, rdec: number, prob: (l: number, h: number) => number | null): LadderRow[] {
  const base = Math.floor(center / step) * step;
  const rows: LadderRow[] = [];
  for (let i = ROWS_EACH_SIDE; i >= -ROWS_EACH_SIDE; i--) {
    const l = Number((base + i * step).toFixed(rdec)), h = Number((base + (i + 1) * step).toFixed(rdec));
    if (l > 0) rows.push({ l, h, p: prob(l, h) });
  }
  return rows;
}

/** Rows priced by the lognormal model (practice expiries). */
export function modelRows(spot: number, vol: number, msLeft: number, step: number, rdec: number): LadderRow[] {
  const s = sigma(vol, msLeft);
  return rangeRows(spot, step, rdec, (l, h) => probInside(spot, l, h, s));
}

export function Ladder({ rows, note, spot, rdec, lo, hi, chanceTitle, fee, onPick }: Props) {
  const pmax = Math.max(...rows.map(r => r.p ?? 0), 1e-9);
  const eps = Math.max(1e-9, Math.abs(hi - lo) * 1e-6);

  return (
    <section className="ladder">
      <div className="panel-h"><b>Range ladder</b><span className="num">{note}</span></div>
      <div className="lad-head"><span>Settles between</span><span title={chanceTitle}>Chance</span><span>Pays</span></div>
      <div className="lad-rows">
        {rows.map(r => {
          const inside = r.l >= lo - eps && r.h <= hi + eps;
          const isSpot = spot >= r.l && spot < r.h;
          return (
            <button
              key={r.l}
              type="button"
              className={`lad-row${inside ? ' in' : ''}${isSpot ? ' spot' : ''}`}
              onClick={e => onPick(r.l, r.h, e.shiftKey)}
            >
              <i className="bar" style={{ width: `${(((r.p ?? 0) / pmax) * 100).toFixed(1)}%` }} />
              <span>{fmtPx(r.l, rdec)}–{fmtPx(r.h, rdec)}</span>
              <span>{r.p == null ? '—' : pct(r.p)}</span>
              <span className="mult">{r.p != null && r.p >= 0.01 && r.p <= 0.95 ? `${((1 - fee) / r.p).toFixed(2)}×` : '—'}</span>
            </button>
          );
        })}
      </div>
      <div className="hint">Click a row to bet on it. Shift-click to stretch your range over several rows.</div>
    </section>
  );
}
