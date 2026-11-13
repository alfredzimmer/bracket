import { useEffect, useState } from 'react';
import type { Account, AssetInfo, Side } from '../../shared/types.ts';
import { api } from '../api.ts';
import { dur, fmtPx, fmtWhen, pct, snapTo, usd } from '../format.ts';

interface Props {
  asset: AssetInfo;
  /** Series key sent with the bet, and its label. */
  seriesKey: string;
  seriesLabel: string;
  /** Prices a range for a stake. Options-backed expiries include the inventory skew, which depends on size. */
  price: (side: Side, lo: number, hi: number, stake: number) => TicketQuote;
  /** Set for options-backed expiries. */
  opt?: { venue: string };
  now: number;
  expiresAt: number;
  side: Side;
  onSide: (s: Side) => void;
  lo: number;
  hi: number;
  onRange: (lo: number, hi: number) => void;
  step: number;
  tick: number;
  rdec: number;
  balance: number;
  onPlaced: (a: Account, msg: string) => void;
}

export type TicketQuote =
  | { ok: true; prob: number; mult: number; skew?: number; fee?: number; hedge?: number[] | null; hedgeCost?: number | null }
  | { ok: false; prob: number; reason: string };

/** Accept a fill if the multiplier hasn't dropped more than this since the quote on screen. */
const SLIPPAGE = 0.02;

function BoundInput({ id, label, value, rdec, onCommit, onStep }: {
  id: string; label: string; value: number; rdec: number; onCommit: (v: number) => void; onStep: (d: number) => void;
}) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(fmtPx(value, rdec)); }, [value, rdec, editing]);
  const commit = () => {
    setEditing(false);
    const v = parseFloat(text.replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) onCommit(v);
    else setText(fmtPx(value, rdec));
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="inp">
        <button type="button" className="step" aria-label={`Lower ${label.toLowerCase()} bound`} onClick={() => onStep(-1)}>−</button>
        <input
          id={id}
          inputMode="decimal"
          value={text}
          onFocus={() => setEditing(true)}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <button type="button" className="step" aria-label={`Raise ${label.toLowerCase()} bound`} onClick={() => onStep(1)}>+</button>
      </div>
    </div>
  );
}

export function Ticket(p: Props) {
  const { asset, seriesKey, seriesLabel, opt, now, expiresAt, side, lo, hi, step, tick, rdec, balance } = p;
  const [stakeText, setStakeText] = useState('100');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => setServerError(null), [asset.sym, seriesKey, side, lo, hi, stakeText]);

  const stake = parseFloat(stakeText) || 0;
  const qt = p.price(side, lo, hi, stake);
  const mult = qt.ok ? qt.mult : 0;

  let err = '';
  if (!opt && !asset.live) err = `The ${asset.sym} price feed is down. Betting resumes when it reconnects.`;
  else if (!qt.ok) err = qt.reason;
  else if (stake < 1) err = 'The minimum stake is 1 USDC.';
  else if (stake > balance) err = `Your stake is more than your ${usd(balance)} USDC available.`;

  const stepBound = (which: 'lo' | 'hi', d: number) => {
    const delta = (d * step) / 2;
    if (which === 'lo') p.onRange(Math.min(hi - tick, snapTo(lo + delta, tick, rdec)), hi);
    else p.onRange(lo, Math.max(lo + tick, snapTo(hi + delta, tick, rdec)));
  };
  const commitBound = (which: 'lo' | 'hi', v: number) => {
    const sv = snapTo(v, tick, rdec);
    const [a, b] = which === 'lo' ? [sv, hi] : [lo, sv];
    p.onRange(Math.min(a, b), Math.max(Math.max(a, b), Math.min(a, b) + tick));
  };

  const place = async (e: React.FormEvent) => {
    e.preventDefault();
    if (err || !qt.ok || busy) return;
    setBusy(true);
    try {
      const r = await api.place({ sym: asset.sym, series: seriesKey, side, lo, hi, stake, minMult: qt.mult * (1 - SLIPPAGE) });
      const b = r.bet;
      p.onPlaced(r.account, `Bet placed: ${b.sym} ${b.side === 'in' ? 'inside' : 'outside'} ${fmtPx(b.lo, rdec)}–${fmtPx(b.hi, rdec)} at ${b.mult.toFixed(2)}×. Pays ${usd(b.payout)} USDC.`);
    } catch (ex) {
      setServerError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const width = hi - lo;
  const word = side === 'in' ? 'inside' : 'outside';

  return (
    <section className="ticket">
      <div className="panel-h"><b>Place a range bet</b><span className="num">{asset.sym} · {seriesLabel}</span></div>
      <form className="tk-body" onSubmit={place} noValidate>
        <div className="side" role="radiogroup" aria-label="Bet side">
          <button type="button" role="radio" aria-checked={side === 'in'} className={`in${side === 'in' ? ' on' : ''}`} onClick={() => p.onSide('in')}>Inside range</button>
          <button type="button" role="radio" aria-checked={side === 'out'} className={`out${side === 'out' ? ' on' : ''}`} onClick={() => p.onSide('out')}>Outside range</button>
        </div>

        <div className="two">
          <BoundInput id="lo" label="Lower" value={lo} rdec={rdec} onCommit={v => commitBound('lo', v)} onStep={d => stepBound('lo', d)} />
          <BoundInput id="hi" label="Upper" value={hi} rdec={rdec} onCommit={v => commitBound('hi', v)} onStep={d => stepBound('hi', d)} />
        </div>
        <div className="width-note num">Width {fmtPx(width, rdec)} ({((width / asset.price) * 100).toFixed(2)}% of mark)</div>

        <div className="field">
          <label htmlFor="stake">Stake <span>Available <span className="num">{usd(balance)}</span></span></label>
          <div className="inp">
            <input id="stake" inputMode="decimal" value={stakeText} onChange={e => setStakeText(e.target.value.replace(/[^\d.]/g, ''))} />
            <span className="unit">USDC</span>
          </div>
          <div className="chips">
            {[0.1, 0.25, 0.5, 1].map(f => (
              <button key={f} type="button" onClick={() => setStakeText((Math.floor(balance * f * 100) / 100).toFixed(2))}>
                {f === 1 ? 'Max' : `${f * 100}%`}
              </button>
            ))}
          </div>
        </div>

        <div className={`payout${side === 'out' ? ' out' : ''}`}>
          <span className="k">Pays if {asset.sym} settles {word}</span>
          <span className="v num">{qt.ok ? usd(stake * mult) : '—'}</span>
        </div>

        <div className="summary">
          <div className="row"><span className="k" title={opt ? `Implied by ${opt.venue}'s ${asset.sym} options` : undefined}>Chance</span><span className="num">{pct(qt.prob)}</span></div>
          <div className="row strong"><span className="k">Multiplier</span><span className="num">{qt.ok ? `${mult.toFixed(2)}×` : '—'}</span></div>
          <div className="row"><span className="k">Profit if you win</span><span className="num up">{qt.ok ? `+${usd(stake * mult - stake)}` : '—'}</span></div>
          <div className="row"><span className="k">Max loss</span><span className="num down">−{usd(stake)}</span></div>
          <div className="row"><span className="k">Settles</span><span className="num">{fmtWhen(expiresAt)} · in {dur(expiresAt - now)}</span></div>
        </div>
        {opt && qt.ok && qt.fee !== undefined && (
          <details className="how">
            <summary>How this is priced</summary>
            <div className="summary">
              <div className="row"><span className="k">Fair value</span><span className="num">{pct(qt.prob)} → {(1 / qt.prob).toFixed(2)}×</span></div>
              <div className="row"><span className="k">House fee</span><span className="num">{(qt.fee * 100).toFixed(0)}% · {usd((stake / qt.prob) * qt.fee)} USDC</span></div>
              {qt.skew !== undefined && (
                <div className="row">
                  <span className="k" title="Bets that add to the house's risk on this expiry pay a little less; bets that offset it pay a little more">Inventory skew</span>
                  <span className={`num ${qt.skew >= 1 ? 'up' : 'down'}`}>{qt.skew >= 1 ? '+' : '−'}{(Math.abs(qt.skew - 1) * 100).toFixed(2)}%</span>
                </div>
              )}
              <div className="row">
                <span className="k" title="Options the house holds against this bet when it hedges">House covers it with</span>
                <span className="num">{qt.hedge ? `${opt.venue} ${qt.hedge.map(k => fmtPx(k, 0)).join(' / ')} condor${side === 'out' ? ' + cash' : ''}` : 'cash'}</span>
              </div>
              <div className="row">
                <span className="k" title="If the house hedged this bet alone, crossing the spread and paying venue fees. It usually doesn't: bets are netted first.">Cost to hedge alone</span>
                <span className="num">{qt.hedgeCost == null ? 'no quote' : `${pct(qt.hedgeCost)} of payout`}</span>
              </div>
            </div>
          </details>
        )}

        <div className="err" role="alert">{serverError ?? err}</div>
        <button className={`place${side === 'out' ? ' out' : ''}`} type="submit" disabled={!!err || busy}>
          {busy ? 'Placing…' : `Bet ${word} ${fmtPx(lo, rdec)}–${fmtPx(hi, rdec)}`}
        </button>
        {opt ? (
          <p className="explain">
            You get stake × multiplier if {asset.sym}'s settlement price is {word} your range, and lose your stake otherwise.
            The settlement price is {opt.venue}'s average over the last 30 minutes to {fmtWhen(expiresAt)}; betting and
            closing early stop when that window starts. You can close early at the current fair value, less the fee.
            Fills only if the multiplier stays within {SLIPPAGE * 100}% of this quote.
          </p>
        ) : (
          <p className="explain">
            If the first {asset.sym} price at settlement lands {word} your range, you receive stake × multiplier.
            Narrower ranges pay more. You can close early at the current mark, less the pool fee.
            Fills only if the multiplier stays within {SLIPPAGE * 100}% of this quote.
          </p>
        )}
      </form>
    </section>
  );
}
