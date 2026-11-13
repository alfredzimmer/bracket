import { type ReactNode, useEffect, useState } from 'react';
import { type DeskData, type DeskSeries, api } from '../api.ts';
import { compactUsd, dur, fmtPx, fmtWhen, usd } from '../format.ts';
import { TopNav } from './Nav.tsx';

const VENUE: Record<string, string> = { derive: 'Derive', hypercall: 'Hypercall' };
const YEAR_MS = 365 * 24 * 3_600_000;
const pctOrDash = (v: number | null, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
const dec = (v: number) => (v >= 1000 ? 0 : v >= 10 ? 1 : 2);

/** House P&L at settlement across prices: unhedged (stakes − payouts) and with the shadow hedge. */
function Profile({ s, now }: { s: DeskSeries; now: number }) {
  const sd = s.fwd * s.atmIv * Math.sqrt(Math.max(s.expiry - now, 60_000) / YEAR_MS);
  const idx = s.grid.map((k, i) => i).filter(i => Math.abs(s.grid[i] - s.fwd) <= 4 * sd);
  if (idx.length < 2) return null;
  const xs = idx.map(i => s.grid[i]);
  const unhedged = idx.map(i => s.stakes - s.liab[i]);
  const hedged = idx.map(i => s.cash + s.hedge[i] - s.liab[i]);
  const W = 640, H = 170, P = 8;
  const yMin = Math.min(...unhedged, ...hedged, -s.limit * 1.1, 0), yMax = Math.max(...unhedged, ...hedged, 0);
  const x = (v: number) => P + ((v - xs[0]) / (xs.at(-1)! - xs[0])) * (W - 2 * P);
  const y = (v: number) => P + ((yMax - v) / (yMax - yMin || 1)) * (H - 2 * P);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <figure className="profile">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="House profit or loss at each settlement price, with and without the shadow hedge">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="pf-zero" />
        <line x1={P} x2={W - P} y1={y(-s.limit)} y2={y(-s.limit)} className="pf-limit" />
        <line x1={x(s.fwd)} x2={x(s.fwd)} y1={P} y2={H - P} className="pf-fwd" />
        <path d={line(unhedged)} className="pf-unhedged" />
        <path d={line(hedged)} className="pf-hedged" />
      </svg>
      <figcaption>
        <span><i className="sw pf-u" />Unhedged</span>
        <span><i className="sw pf-h" />With shadow hedge</span>
        <span><i className="sw pf-l" />−limit ({compactUsd(s.limit)})</span>
        <span className="num muted">{fmtPx(xs[0], 0)} … {fmtPx(xs.at(-1)!, 0)} (forward ±4σ)</span>
      </figcaption>
    </figure>
  );
}

function SeriesCard({ s, now }: { s: DeskSeries; now: number }) {
  const stat = (k: string, v: ReactNode, title?: string, cls = '') => (
    <div className="dk-stat" title={title}><span className="k">{k}</span><span className={`v num ${cls}`}>{v}</span></div>
  );
  return (
    <article className="dk-card">
      <header>
        <b>{s.sym}</b>
        <span className="muted">{fmtWhen(s.expiry)} · {VENUE[s.venue]} · in {dur(s.expiry - now)}</span>
        {!s.open && <span className="pill st-closed">closed for settlement</span>}
      </header>
      <div className="dk-stats">
        {stat('Bets', s.bets)}
        {stat('Stakes', usd(s.stakes))}
        {stat('Liability (mark)', usd(s.liabValue), 'What open bets are worth at option marks')}
        {stat('Hedge P&L (mark)', signed(s.hedgePnl), 'Shadow positions at marks (perp at the forward) minus what they cost, less fees', s.hedgePnl >= 0 ? 'up' : 'down')}
        {stat('P&L (mark)', signed(s.pnl), 'Cash + hedge value − liability value', s.pnl >= 0 ? 'up' : 'down')}
        {stat('Worst case, never hedged', signed(-s.worstUnhedged), 'Worst house result at settlement had the house never hedged. It ignores hedge costs already paid, so after the book changes it can look better than the hedged figure.', s.worstUnhedged > s.limit ? 'down' : '')}
        {stat('Worst case, hedged', signed(-s.worstHedged), 'Worst house result at settlement with the shadow hedge', s.worstHedged > s.limit ? 'down' : '')}
        {stat('Hedge fees', usd(s.fees), 'Simulated Derive taker fees, including the $0.50 per order')}
        {stat('Spread paid', usd(s.slippage), 'Σ (fill − mark) × qty: the cost of crossing the bid/ask')}
      </div>
      <Profile s={s} now={now} />
      {s.positions.length > 0 && (
        <div className="tbl-wrap"><table className="narrow">
          <thead><tr><th>Shadow position</th><th className="r">Qty</th><th className="r">Avg price</th><th className="r">Mark</th><th className="r">P&L</th></tr></thead>
          <tbody>
            {s.positions.filter(p => Math.abs(p.qty) > 1e-9).map(p => (
              <tr key={p.instrument}>
                <td className="num">{p.instrument}</td>
                <td className={`r num ${p.qty >= 0 ? 'up' : 'down'}`}>{p.qty.toFixed(4)}</td>
                <td className="r num">{fmtPx(p.cost / p.qty, dec(Math.abs(p.cost / p.qty)))}</td>
                <td className="r num">{fmtPx(p.mark, dec(p.mark))}</td>
                <td className={`r num ${p.value - p.cost >= 0 ? 'up' : 'down'}`}>{signed(p.value - p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </article>
  );
}

export function Desk() {
  const [d, setD] = useState<DeskData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [venue, setVenue] = useState('all');

  useEffect(() => {
    let alive = true;
    const load = () => api.desk().then(r => { if (alive) { setD(r); setErr(null); } }).catch(e => alive && setErr((e as Error).message));
    load();
    const i = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(i); };
  }, []);

  const now = d?.t ?? Date.now();
  const active = d?.series.filter(s => s.bets > 0 || s.positions.length > 0) ?? [];
  const spreads = d?.spreads.filter(r => venue === 'all' || r.venue === venue) ?? [];

  return (
    <div className="app desk">
      <TopNav active="desk" right={<span className="badge">Shadow only · nothing is sent to Derive</span>} />
      {err && <div className="banner">{err}</div>}
      {!d ? <p className="empty">Loading the desk…</p> : (
        <>
          <section className="dk-sec">
            <div className="panel-h"><b>House book · shadow hedger</b><span className="num">limit {compactUsd(d.riskLimit)} worst-case loss per expiry</span></div>
            <p className="dk-note">
              Users bet on a range at fair value (implied by {VENUE.derive}'s options) less a 6% fee. Each bet maps to a condor on
              listed strikes that covers it (inside) or that it covers (outside), so an expiry's book is net calls per strike.
              Opposite bets cancel. When an expiry's worst-case loss passes the limit, the hedger moves toward that target by
              whichever fraction cuts the worst case by more than the spread and fees it pays, and otherwise carries the risk.
              Fills are simulated against live quotes; nothing is sent to the venue.
            </p>
            {active.length === 0
              ? <p className="empty">No open options-backed bets. Place some on an Options expiry and the book shows up here.</p>
              : <div className="dk-cards">{active.map(s => <SeriesCard key={`${s.sym}:${s.expiry}`} s={s} now={now} />)}</div>}
          </section>

          <section className="dk-sec">
            <div className="panel-h"><b>Shadow fills</b><span className="num">latest {d.fills.length}</span></div>
            {d.fills.length === 0 ? <p className="empty">No shadow trades yet.</p> : (
              <div className="tbl-wrap"><table>
                <thead><tr><th>When</th><th>Instrument</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Mark</th><th className="r">Spread paid</th><th className="r">Fee</th><th>Why</th></tr></thead>
                <tbody>
                  {d.fills.map(f => (
                    <tr key={f.id}>
                      <td className="num muted">{fmtWhen(f.t)}</td>
                      <td className="num">{f.instrument}</td>
                      <td className={`r num ${f.qty >= 0 ? 'up' : 'down'}`}>{f.qty.toFixed(4)}</td>
                      <td className="r num">{fmtPx(f.price, dec(f.price))}</td>
                      <td className="r num">{fmtPx(f.mark, dec(f.mark))}</td>
                      <td className="r num">{usd((f.price - f.mark) * f.qty)}</td>
                      <td className="r num">{usd(f.fee)}</td>
                      <td className="muted">{f.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          <section className="dk-sec">
            <div className="panel-h"><b>Settled expiries</b><span className="num">house result with and without the hedge</span></div>
            {d.results.length === 0 ? <p className="empty">No options-backed expiry has settled with bets on it yet.</p> : (
              <div className="tbl-wrap"><table>
                <thead><tr>
                  <th>Expiry</th><th>Market</th><th className="r">Settled at</th><th className="r">Bets</th><th className="r">Stakes</th><th className="r">Paid out</th>
                  <th className="r">Unhedged P&L</th><th className="r">Hedge P&L</th><th className="r">Hedged P&L</th>
                </tr></thead>
                <tbody>
                  {d.results.map(r => {
                    const unhedged = r.stakes - r.paid_out;
                    const hedge = r.hedge_payoff - r.hedge_cost - r.hedge_fees;
                    return (
                      <tr key={`${r.sym}:${r.expiry}`}>
                        <td className="num">{fmtWhen(r.expiry)}</td>
                        <td><b>{r.sym}</b> <span className="muted">{VENUE[r.venue]}</span></td>
                        <td className="r num">{fmtPx(r.settle_price, dec(r.settle_price))}</td>
                        <td className="r num">{r.bets}</td>
                        <td className="r num">{usd(r.stakes)}</td>
                        <td className="r num">{usd(r.paid_out)}</td>
                        <td className={`r num ${unhedged >= 0 ? 'up' : 'down'}`}>{signed(unhedged)}</td>
                        <td className={`r num ${hedge >= 0 ? 'up' : 'down'}`}>{signed(hedge)}</td>
                        <td className={`r num ${unhedged + hedge >= 0 ? 'up' : 'down'}`}>{signed(unhedged + hedge)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </section>

          <section className="dk-sec">
            <div className="panel-h">
              <b>Hedge cost · last 24h</b>
              <div className="seg" role="radiogroup" aria-label="Venue">
                {['all', 'derive', 'hypercall'].map(v => (
                  <button key={v} role="radio" aria-checked={venue === v} className={venue === v ? 'on' : ''} onClick={() => setVenue(v)}>{v === 'all' ? 'All' : VENUE[v]}</button>
                ))}
              </div>
            </div>
            <p className="dk-note">
              For each venue and expiry, standard ranges (sized in σ of the expected move) are priced at marks and as a taker:
              buying the condor (what the house does after selling "inside" bets) and selling it (after "outside" bets).
              Markups are relative to the mark value. Hypercall's book is usually empty, so its costs use makers'
              indicative quotes, which you can't hit directly. Fees exclude the flat per-order fee.
            </p>
            {spreads.length === 0 ? <p className="empty">No samples yet. The first one is taken about 20 seconds after the server starts, then every few minutes.</p> : (
              <div className="tbl-wrap"><table>
                <thead><tr>
                  <th>Venue</th><th>Market</th><th>Tenor</th><th>Range</th><th>Quotes</th><th className="r">Samples</th><th className="r">Executable</th>
                  <th className="r" title="Median value at marks per $1 of payout">Mark</th><th className="r">Buy markup</th><th className="r">Sell markup</th><th className="r">Fees</th>
                </tr></thead>
                <tbody>
                  {spreads.map(r => (
                    <tr key={`${r.venue}${r.sym}${r.tenor}${r.shape}${r.quoteKind}`}>
                      <td>{VENUE[r.venue]}</td>
                      <td><b>{r.sym}</b></td>
                      <td className="num">{r.tenor}</td>
                      <td className="num">{r.shape}</td>
                      <td className="muted">{r.quoteKind}</td>
                      <td className="r num">{r.n}</td>
                      <td className="r num">{pctOrDash(r.executable, 0)}</td>
                      <td className="r num">{r.mark.toFixed(3)}</td>
                      <td className="r num">{pctOrDash(r.buyMarkup)}</td>
                      <td className="r num">{pctOrDash(r.sellMarkup)}</td>
                      <td className="r num">{pctOrDash(r.fee)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
