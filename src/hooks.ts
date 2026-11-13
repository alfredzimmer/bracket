import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AssetInfo, Candle, CurvesEvent, MarketsResponse, OptSeriesInfo, PoolInfo, PricesEvent } from '../shared/types.ts';
import { api } from './api.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface BracketState {
  markets: MarketsResponse | null;
  assets: AssetInfo[];
  pool: PoolInfo | null;
  account: Account | null;
  /** Options-backed series (all assets), with their curves and house books. */
  opt: OptSeriesInfo[];
  setAccount: (a: Account) => void;
  refreshAccount: () => Promise<void>;
  /** Server-aligned clock. */
  now: number;
  /** True while the live stream is disconnected. */
  offline: boolean;
  bootError: string | null;
}

export function useBracket(): BracketState {
  const [markets, setMarkets] = useState<MarketsResponse | null>(null);
  const [prices, setPrices] = useState<PricesEvent | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [curves, setCurves] = useState<CurvesEvent | null>(null);
  const [offline, setOffline] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const offset = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        try {
          const m = await api.markets();
          offset.current = m.serverTime - Date.now();
          const acc = await api.session();
          const opt = await api.opt().catch(() => null);
          if (!alive) return;
          if (opt) setCurves(opt);
          setMarkets(m);
          setAccount(acc);
          setBootError(null);
          return;
        } catch (e) {
          setBootError((e as Error).message);
          await sleep(3000);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  const refreshAccount = useCallback(async () => {
    try { setAccount(await api.me()); } catch {}
  }, []);

  const accountId = account?.id;
  useEffect(() => {
    if (!accountId) return;
    const es = new EventSource(api.streamUrl());
    es.addEventListener('prices', ev => {
      const p = JSON.parse((ev as MessageEvent).data) as PricesEvent;
      offset.current = p.t - Date.now();
      setPrices(p);
      setOffline(false);
    });
    es.addEventListener('curves', ev => setCurves(JSON.parse((ev as MessageEvent).data) as CurvesEvent));
    es.addEventListener('account', () => { refreshAccount(); });
    es.onerror = () => setOffline(true);
    const poll = setInterval(refreshAccount, 15_000);
    return () => { es.close(); clearInterval(poll); };
  }, [accountId, refreshAccount]);

  // Keep countdowns moving even if the stream drops.
  useEffect(() => {
    const i = setInterval(() => setClock(c => c + 1), 1000);
    return () => clearInterval(i);
  }, []);

  const assets = (markets?.assets ?? []).map(a => {
    const p = prices?.assets[a.sym];
    return p ? { ...a, price: p.price, chg24h: p.chg24h, live: p.live && !offline } : { ...a, live: a.live && !offline };
  });

  return {
    markets, assets, pool: prices?.pool ?? markets?.pool ?? null,
    account, opt: curves?.series ?? [], setAccount, refreshAccount,
    now: Date.now() + offset.current, offline, bootError,
  };
}

const KEEP = 420;

/** Candles for one market, extended by live prices between fetches. */
export function useCandles(sym: string, gran: number, price: number, now: number): Candle[] {
  const [candles, setCandles] = useState<Candle[]>([]);

  useEffect(() => {
    let alive = true;
    setCandles([]);
    const load = () => api.candles(sym, gran).then(c => { if (alive) setCandles(c); }).catch(() => {});
    load();
    const i = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(i); };
  }, [sym, gran]);

  useEffect(() => {
    if (!(price > 0)) return;
    setCandles(cs => {
      const last = cs.at(-1);
      if (!last) return cs;
      const sec = Math.floor(now / 1000);
      const bucket = sec - (sec % gran);
      if (bucket === last.t) {
        if (last.c === price) return cs;
        return [...cs.slice(0, -1), { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price }];
      }
      if (bucket > last.t) return [...cs.slice(-(KEEP - 1)), { t: bucket, o: price, h: price, l: price, c: price }];
      return cs;
    });
  }, [price, now, gran]);

  return candles;
}
