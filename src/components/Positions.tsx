import { useEffect, useState } from 'react';
import { ASSET_BY_SYM, SERIES } from '../../shared/markets.ts';
import { inFraction, optMarkValue, parseOptSeries, rangeFair, rangeMarkValue, rangeShape, rangeValue } from '../../shared/options.ts';
import { markValue, sigma, winProb } from '../../shared/pricing.ts';
import type { Account, AssetInfo, Bet, LeaderRow, OptSeriesInfo } from '../../shared/types.ts';
import { type RecentBet, api } from '../api.ts';
import { decimalsFor, dur, fmtPx, fmtWhen, pct, usd } from '../format.ts';

interface Props {
  account: Account;
  assets: AssetInfo[];
  opt: OptSeriesInfo[];
  now: number;
  onAccount: (a: Account, msg: string) => void;
  onError: (msg: string) => void;
}

type Tab = 'open' | 'history' | 'leaders';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export function seriesLabel(k: string): string {
  const exp = parseOptSeries(k);
  return exp !== null ? dayFmt.format(exp) : `Practice · ${SERIES.find(s => s.key === k)?.label ?? k}`;
}
const STATUS: Record<Bet['status'], string> = { open: 'Open', won: 'Won', lost: 'Lost', partial: 'Partial', closed: 'Closed early', void: 'Refunded' };
type MarkState = 'Winning' | 'Losing' | 'Partial';

function Range({ b }: { b: Bet }) {
  const dec = ASSET_BY_SYM[b.sym]?.dec ?? 2;
  const fmt = (v: number) => fmtPx(v, Math.min(6, Math.max(dec, decimalsFor(v))));
  return <span className="num">{fmt(b.lo)} – {fmt(b.hi)}</span>;
}

const short = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : fmtPx(v, v < 10 ? 2 : 0));

/** Latest bets from everyone, scrolling. Doubled so the loop is seamless. */
function Tape({ tick }: { tick: number }) {
  const [rows, setRows] = useState<RecentBet[]>([]);
  useEffect(() => { api.recent().then(setRows).catch(() => {}); }, [tick]);
  if (!rows.length) return <div className="tape"><span className="tape-fill">bracket · ranges priced off derive options</span></div>;
  const items = (pass: string) => rows.map(r => (
    <span key={`${pass}${r.id}`} className="tape-item" aria-hidden={pass === 'b' || undefined}>
      <span className={r.side === 'in' ? 'up' : 'down'}>{r.side === 'in' ? '▲' : '▼'}</span>
      <span className="sym">{r.sym}</span>
      <span>{short(r.lo)}–{short(r.hi)}</span>
      <span className={r.side === 'in' ? 'up' : 'down'}>{r.mult.toFixed(2)}×</span>
      <span className="muted">${short(r.stake)}</span>
    </span>
  ));
  return (
    <div className="tape" aria-label="Latest bets">
      <div className="tape-track">{items('a')}{items('b')}</div>
    </div>
  );
}

export function Positions({ account, assets, opt, now, onAccount, onError }: Props) {
  const [tab, setTab] = useState<Tab>('open');
  const [leaders, setLeaders] = useState<LeaderRow[] | null>(null);
  const [closing, setClosing] = useState<number | null>(null);
  const priceOf = (sym: string) => assets.find(a => a.sym === sym);

  useEffect(() => {
    if (tab !== 'leaders') return;
    let alive = true;
    const load = () => api.leaderboard().then(r => { if (alive) setLeaders(r); }).catch(() => {});
    load();
    const i = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(i); };
  }, [tab]);

  const mark = (b: Bet): { p: number; value: number; state: MarkState; live: boolean } => {
    if (b.kind === 'opt') {
      const s = opt.find(x => x.sym === b.sym && x.expiry === b.expiresAt);
      if (s && b.wl <= 0) {
        const inside = s.curve.fwd >= b.lo && s.curve.fwd <= b.hi;
        return {
          p: rangeFair(s.curve, b.side, b.lo, b.hi), value: rangeMarkValue(s.curve, b.side, b.lo, b.hi, b.payout),
          state: (b.side === 'in') === inside ? 'Winning' : 'Losing', live: s.open,
        };
      }
      const shape = s && rangeShape(s.curve.strikes, b.lo, b.hi);
      if (!s || !shape) return { p: 0, value: 0, state: 'Losing', live: false };
      const f = inFraction(b.lo, b.hi, b.wl, b.wh, s.curve.fwd);
      const pays = b.side === 'in' ? f : 1 - f;
      const value = optMarkValue(s.curve, b.side, b.lo, b.hi, b.payout);
      return {
        p: rangeValue(s.curve, shape, b.side), value: value ?? 0,
        state: pays >= 1 ? 'Winning' : pays <= 0 ? 'Losing' : 'Partial', live: s.open && value !== null,
      };
    }
    const a = priceOf(b.sym);
    if (!a) return { p: 0, value: 0, state: 'Losing', live: false };
    const p = winProb(b.side, a.price, b.lo, b.hi, sigma(a.vol, b.expiresAt - now));
    const inside = a.price >= b.lo && a.price <= b.hi;
    return { p, value: markValue(b.payout, p), state: (b.side === 'in' ? inside : !inside) ? 'Winning' : 'Losing', live: a.live };
  };

  const close = async (b: Bet) => {
    const { value } = mark(b);
    setClosing(b.id);
    try {
      const r = await api.close(b.id, value * 0.98);
      onAccount(r.account, `Closed ${b.sym} bet for ${usd(r.bet.returned ?? 0)} USDC.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setClosing(null);
    }
  };

  return (
    <section className="pos">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open bets ({account.open.length})</button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
        <button role="tab" aria-selected={tab === 'leaders'} className={tab === 'leaders' ? 'on' : ''} onClick={() => setTab('leaders')}>Leaderboard</button>
        <Tape tick={Math.floor(now / 15_000) + account.open.length} />
      </div>
      <div className="tbl-wrap">
        {tab === 'open' && (
          account.open.length === 0
            ? <p className="empty">No open bets. Drag a range on the chart or pick a row in the ladder, then place a bet.</p>
            : <table>
                <thead><tr>
                  <th>Market</th><th>Side</th><th>Range</th><th className="r">Stake</th><th className="r">Payout</th>
                  <th className="r">Win chance now</th><th className="r">Mark value</th><th className="r">PnL</th><th>Status</th><th>Settles</th><th />
                </tr></thead>
                <tbody>
                  {account.open.map(b => {
                    const m = mark(b);
                    const pnl = m.value - b.stake;
                    const settling = b.expiresAt <= now;
                    return (
                      <tr key={b.id}>
                        <td><b>{b.sym}</b> <span className="muted">{seriesLabel(b.series)}</span></td>
                        <td><span className={`pill ${b.side}`}>{b.side === 'in' ? 'Inside' : 'Outside'}</span></td>
                        <td><Range b={b} /></td>
                        <td className="r num">{usd(b.stake)}</td>
                        <td className="r num">{usd(b.payout)}</td>
                        <td className="r num">{settling ? '—' : pct(m.p)}</td>
                        <td className="r num">{settling ? '—' : usd(m.value)}</td>
                        <td className={`r num ${pnl >= 0 ? 'up' : 'down'}`}>{settling ? '—' : `${pnl >= 0 ? '+' : '−'}${usd(Math.abs(pnl))}`}</td>
                        <td className={m.state === 'Winning' ? 'up' : m.state === 'Losing' ? 'down' : 'muted'} title={b.kind === 'opt' ? 'At the current forward price' : undefined}>{m.state}</td>
                        <td className="num muted" title={fmtWhen(b.expiresAt)}>{settling ? 'Settling…' : `in ${dur(b.expiresAt - now)}`}</td>
                        <td>
                          <button className="close-btn" disabled={settling || !m.live || closing === b.id} onClick={() => close(b)}>
                            {closing === b.id ? 'Closing…' : `Close for ${usd(m.value)}`}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
        )}

        {tab === 'history' && (
          account.history.length === 0
            ? <p className="empty">Settled and closed bets will show up here.</p>
            : <table>
                <thead><tr>
                  <th>Market</th><th>Side</th><th>Range</th><th className="r">Stake</th><th className="r">Mult</th>
                  <th className="r">Settle price</th><th className="r">Returned</th><th className="r">PnL</th><th>Result</th><th>When</th>
                </tr></thead>
                <tbody>
                  {account.history.map(b => {
                    const ret = b.returned ?? 0;
                    const pnl = ret - b.stake;
                    const dec = ASSET_BY_SYM[b.sym]?.dec ?? 2;
                    return (
                      <tr key={b.id}>
                        <td><b>{b.sym}</b> <span className="muted">{seriesLabel(b.series)}</span></td>
                        <td><span className={`pill ${b.side}`}>{b.side === 'in' ? 'Inside' : 'Outside'}</span></td>
                        <td><Range b={b} /></td>
                        <td className="r num">{usd(b.stake)}</td>
                        <td className="r num">{b.mult.toFixed(2)}×</td>
                        <td className="r num">{b.settlePrice == null ? '—' : fmtPx(b.settlePrice, dec)}</td>
                        <td className="r num">{usd(ret)}</td>
                        <td className={`r num ${pnl >= 0 ? 'up' : 'down'}`}>{pnl >= 0 ? '+' : '−'}{usd(Math.abs(pnl))}</td>
                        <td><span className={`pill st-${b.status}`}>{STATUS[b.status]}</span></td>
                        <td className="num muted">{fmtWhen(b.closedAt ?? b.expiresAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
        )}

        {tab === 'leaders' && (
          !leaders ? <p className="empty">Loading leaderboard…</p>
          : leaders.length === 0 ? <p className="empty">Nobody has placed a bet yet. Yours could be the first row.</p>
          : <table className="narrow">
              <thead><tr><th>#</th><th>Trader</th><th className="r">Equity</th><th className="r">PnL</th><th className="r">Open bets</th></tr></thead>
              <tbody>
                {leaders.map((r, i) => (
                  <tr key={r.name} className={r.you ? 'you' : ''}>
                    <td className="num muted">{i + 1}</td>
                    <td>{r.name}{r.you && <span className="pill in">you</span>}</td>
                    <td className="r num">{usd(r.equity)}</td>
                    <td className={`r num ${r.pnl >= 0 ? 'up' : 'down'}`}>{r.pnl >= 0 ? '+' : '−'}{usd(Math.abs(r.pnl))}</td>
                    <td className="r num">{r.openBets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        )}
      </div>
    </section>
  );
}
