const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH ?? 'data/bracket.db',
  prod: process.env.NODE_ENV === 'production',
  /** Skip Coinbase and simulate every asset (useful offline). */
  simOnly: process.env.SIM_ONLY === '1',
  /** Demo USDC each new account starts with. */
  startBalance: num(process.env.START_BALANCE, 10_000),
  /** House pool seeded on first run. */
  poolStart: num(process.env.POOL_START, 2_000_000),
  /** Largest payout a single bet may have, as a fraction of the pool. */
  maxPayoutFraction: num(process.env.MAX_PAYOUT_FRACTION, 0.005),
  /** A live feed with no tick for this long stops taking bets. */
  staleMs: 30_000,
  /** Bets whose settlement price can't be found after this long are refunded. */
  voidAfterMs: 15 * 60_000,

  /* ----- options-backed markets (Phases 0–2: read-only venue data, paper bets, shadow hedger) ----- */
  /** Skip all venue polling (offline). Options-backed expiries disappear; practice markets keep working. */
  optOff: process.env.OPT_OFF === '1',
  /** Furthest expiry offered as an options-backed series. */
  optMaxDays: num(process.env.OPT_MAX_DAYS, 30),
  /** Betting closes this long before expiry: Derive settles on a 30-minute TWAP, so the price is partly known after that. */
  optCutoffMs: 30 * 60_000,
  /** A chain older than this is stale: its series stops taking bets and closes. */
  optStaleMs: 90_000,
  /** Derive chain refresh (per expiry) and instrument-list refresh. */
  derivePollMs: num(process.env.DERIVE_POLL_MS, 15_000),
  deriveListMs: 10 * 60_000,
  /** Hypercall is research-only (Phase 0); one call returns every expiry, ~650 KB. */
  hypercallPollMs: num(process.env.HYPERCALL_POLL_MS, 60_000),
  /** Phase 0 hedge-cost sampling interval and retention (~3 MB/day at these defaults). */
  sampleMs: num(process.env.SAMPLE_MS, 10 * 60_000),
  sampleKeepDays: num(process.env.SAMPLE_KEEP_DAYS, 14),
  /** Worst-case loss per series (USDC) above which the shadow hedger trades. */
  riskLimit: num(process.env.RISK_LIMIT, 10_000),
  hedgeEveryMs: 30_000,
  /** Settlement prices not published this long after expiry refund the series. */
  optVoidAfterMs: 24 * 3_600_000,
};
