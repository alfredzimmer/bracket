export const fmtPx = (v: number, dec: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const usd = (v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;

export const signedPct = (p: number) => `${p >= 0 ? '+' : ''}${(p * 100).toFixed(2)}%`;

export function compactUsd(v: number): string {
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${usd(v)}`;
}

export function dur(ms: number): string {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60, ss = Math.floor(ms / 1000) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(mm).padStart(2, '0')}m`;
  return `${mm}m ${String(ss).padStart(2, '0')}s`;
}

const whenFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtWhen = (ts: number) => whenFmt.format(ts);

/** Decimals needed to show multiples of `tick` exactly. */
export function decimalsFor(tick: number): number {
  for (let d = 0; d <= 8; d++) {
    const x = tick * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-6) return d;
  }
  return 8;
}

export const snapTo = (v: number, tick: number, dec: number) => Number((Math.round(v / tick) * tick).toFixed(dec));
