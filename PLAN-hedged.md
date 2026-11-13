# Plan: Bracket backed by on-chain options (Derive / Hypercall)

Status: Phases 0–2 built 2026-11-13 as a paper-only learning project (see README, "Options-backed expiries").
Phases 3–5 are out of scope: there are no keys, no orders and no real money. Decisions taken: soft-edged ranges, Derive as the
priced/settled/hedged venue, Hypercall research-only. Venue facts come from live public APIs pulled on 2026-11-13 around 18:00 UTC.
They are a snapshot and must be checked again before anything ships.

## 0. The idea in one paragraph

A Bracket bet pays out if the price settles inside (or outside) a range at expiry. That payoff can be built from vanilla
options: a call condor gives the "in" payoff, and two spreads (a put spread plus a call spread) give the "out" payoff. Derive
and Hypercall both list European, cash-settled BTC/ETH options. Bracket keeps its simple UI, prices bets off the venues'
real volatility surface, nets all user bets into one book, and hedges only the **net** risk on-chain. That turns the house
pool from a bet against users into something closer to a market maker that earns the fee.

## Findings so far (first samples, 2026-11-13; run `pnpm report` for current numbers)

- **Fees outweigh the spread on Derive.** Its taker fee is 0.03% of *index notional* per contract, and a condor has four legs.
  Per $1 of payout that is about 4 × 0.0003 × spot / strike step, i.e. ~8% for BTC with 1,000-wide steps, plus $0.50 per order.
  The 12.5%-of-premium cap only binds for cheap options. Wide ranges (±1–1.5σ) cost ~3–5% in fees; narrow ones 10–20%.
- **Spreads:** crossing the book costs ~3–5% over mark for ±1σ ranges at 1–7 days, 8–20% for narrow or off-centre ones,
  and more on the same-day expiry.
- **The 3% house fee doesn't cover a taker hedge.** In the first shadow test, hedging four bets ($5,600 staked) cost about
  $470 of spread and $400 of fees, locking in a −$578 result. Netting opposite bets, hedging only past the limit, and
  (in a real build) maker orders or Derive's multi-leg RFQ discount are what would make it work.
- **Hypercall** marks can be stale last-trade prices, so the adapter uses the indicative mid and falls back to Hypercall's
  model price. Indicative spreads run 15–60% of a condor's value, and they aren't firm.

## 1. What the venues actually offer (checked)

| | Derive | Hypercall |
|---|---|---|
| Option underlyings | BTC, ETH, SOL, HYPE (plus others in the Alt universe) | BTC, ETH, SP500, NVDA, AAPL, META, MSFT, MU, SNDK, BABA, SPCX, BOT, ANT |
| Crypto expiries | 08:00 UTC: next ~4 days daily (including Sat/Sun), Fridays weekly, then monthly/quarterly | 08:00 UTC: Sat/Sun dailies, then Fridays weekly through Dec 25 |
| Equity expiries | none | 20:00 **or 21:00** UTC (the docs say a fixed 20:00, but the live data shows 21:00 on several), so never hard-code it |
| BTC strike grid, near term | 1,000 (some 500/2,000); ~20–36 strikes per expiry | 500 (dailies), 1,000 (weeklies); 35–65 strikes |
| ETH strike grid, near term | 25–50 | 25–50 |
| Settlement price | 30-min TWAP of the spot index, 1 sample/min | 30-min window of HL oracle prices, trimmed, median of group means; never settles on a partial window ("Expired Pending Price") |
| Min size | BTC 0.01, ETH 0.1, SOL 1, HYPE 10 contracts | 1e-6 |
| Fees | taker $0.50 + min(0.03% notional, 12.5% premium) per leg; maker min(0.01%, 12.5%) | 0% today; planned 0.02/0.05%, capped at 12.5% premium |
| Order book liquidity (BTC Nov 20) | 38 of 60 instruments two-sided, top sizes ~2–8 BTC | **0 of 130 instruments had a resting bid or ask.** Liquidity is RFQ-only in practice |
| RFQ | `send_rfq` → `poll_quotes` → `execute_quote`; each leg ≥ 100 × min amount (1 BTC); **20 RFQs/day per wallet** (+5 per fill) | RFQ V2, 1–10 legs, whitelisted makers, no minimum size |
| Testnet | yes (Sepolia, `testnet.api.derive.xyz/v3`) | **disabled**, production only |
| Geo | check the terms | **US persons, UK, EEA, Canada, Australia and others are banned**; resale/redistribution of data is prohibited |

### Measured hedge cost (BTC, Nov 20 08:00 expiry, spot ≈ 68,900)

Cost per $1 of payout for a condor with 1,000-wide ramps, crossing the Derive book versus at mark:

| Range | Mark (fair) | Executable at bid/ask | Markup from the spread |
|---|---|---|---|
| 68k–70k | 0.383 | 0.509 | +33% |
| 67k–71k | 0.593 | 0.718 | +21% |
| 70k–74k | 0.412 | 0.482 | +17% |
| 65k–73k | 0.841 | 0.991 | +18% |

**What this means.** Hedging each bet one by one by crossing the book is not viable. A fair 2.6× payout drops to about 1.9× before
our own fee, and retail bet sizes are far below the venue minimums anyway (Derive RFQ needs 1 BTC per leg, which is about $1,000 of
payout per strike step). The business only works if we **net bets internally, price off the mark, and hedge the net residual**
in size, as a maker where possible. This is the central design decision. Everything below follows from it.

## 2. Hard blockers to settle before writing code

1. **Legal / jurisdiction (blocking).** Selling binary/range payoffs for real money to the public is regulated almost everywhere:
   CFTC swaps/event contracts in the US, gambling or CFD rules elsewhere. Hypercall's terms exclude US persons, the UK, the EEA,
   Canada and Australia, as **the operator** as well as the user. If we are US-based, Hypercall is off the table and Derive's terms
   need checking. Get a lawyer's read before Phase 5. Phases 0–4 can run on paper money and testnet without this answer.
2. **Product payoff shape (decision).** See §3. Recommendation: "soft edges".
3. **Expiry schedule (decision).** Real-money markets can only use expiries a venue lists: 08:00 UTC for crypto. Hourly, 4h and
   00:00 dailies stay paper-only, or are dropped.

## 3. Product definition

**Recommended: soft-edged range (exact replication).** The bet pays 100% inside [lo, hi]. It pays linearly less across one strike
step outside each edge, reaching 0 at lo − w and hi + w (w = the strike grid step). That is exactly a call condor, so the hedge
has no model risk. In the UI, show the ramps as shaded zones on the ladder ("partial payout"). The "out" side is 1 − condor, which
is also exact.

Alternative: a hard-edged binary hedged by the super-replicating condor (lo − w, lo, hi, hi + w). The hedge always pays at least
the bet, so the house is safe, but the user is charged the condor price for a narrower payoff, which worsens multipliers by about
w / (hi − lo). That is acceptable for wide ranges and bad for narrow ones.

Constraints that follow from this choice:
- Range edges snap to the venue's strike grid for that expiry. The ladder step becomes the strike grid, not `ladderStep()`.
- Expiries come from the venue's instrument list, not `shared/markets.ts`.
- Settlement uses the **venue's published settlement price** for that expiry (Derive `public/get_option_settlement_prices`,
  Hypercall settlement) so that bet and hedge settle on the same number. Bracket's current price (the first Coinbase trade after expiry)
  would leave basis risk exactly where pinned ranges hurt.

## 4. Architecture

```
            ┌───────────── server (no runtime deps, as today) ─────────────┐
 venues ──► │ venue feed  →  surface (per expiry: strike → call mark, IV)  │──SSE──► client (prices with the same
 (public)   │                     │                                          │         shared module)
            │ engine: place/close/settle bets → exposure book (SQLite)      │
            └──────────────────────────┬────────────────────────────────────┘
                                       │ exposure vector (read-only DB access or local HTTP)
            ┌──────────────────────────▼────────────────────────────────────┐
            │ hedger (separate process: has keys and signing deps)          │
            │ target = −exposure  →  diff vs venue positions  →  orders/RFQ  │──► Derive / Hypercall
            │ reconcile loop · limits · kill switch                          │
            └───────────────────────────────────────────────────────────────┘
```

Why a separate hedger process: signing needs secp256k1/EIP-712 (`viem` or `@noble/curves`). Keeping it out of `server/`
keeps the API dependency-free, as it is now, and keeps private keys out of the internet-facing process.

### 4.1 Payoff algebra (the core abstraction)

Every bet is a piecewise-linear payoff on the strike grid, so it can be written exactly as cash plus a vector of call positions:

```
in  [lo,hi], step w, payout P:   (P/w)·( +C(lo−w) −C(lo) −C(hi) +C(hi+w) )
out [lo,hi]:                      P·cash − the above
```

The house book for one (venue, underlying, expiry) is then just `Map<strike, netCallQty>` plus cash. Everything else reads off
that map:
- **Price** = Σ qty × callMark(K): exact and skew-aware, with no vol model to maintain.
- **Worst-case loss** = evaluate the payoff at every grid strike (exact, because the payoff is linear between strikes).
- **Hedge target** = the negated map, rounded to `amount_step` / `minimum_amount`. Using puts or calls for a given strike is an
  execution choice (put–call parity), not a book choice. Pick whichever is cheaper or more liquid.

### 4.2 Pricing to users

`fair = Σ qty × mid` (mid from the venue mark, or a fitted smile when the book is one-sided). Then:
`userPrice = fair × (1 + fee) + inventorySkew`, where the skew grows with how much the bet adds to the existing worst-case
loss. Bets that reduce risk get better prices. This is the "dynamic spreads" item from the README.
The server still re-prices every bet and keeps the existing `minMult` 2% slippage guard.

### 4.3 Hedging policy

- Run every N seconds and on large bets. Compute the unhedged worst-case loss per expiry.
- If it is inside the limit: do nothing. Small residual risk is the cost of netting and is covered by the fee.
- If it is over the limit: hedge the buckets that cut the worst case the most. On Derive, post maker limit orders at or near mid
  first, then cross after a timeout. Use RFQ only for size ≥ 1 BTC per leg, keeping the 20/day cap in mind. On Hypercall, use
  RFQ V2 only.
- Every intended order is written to `hedge_intents` before it is sent (idempotency). Fills are reconciled against the venue's
  positions endpoint every minute. On any mismatch the hedger stops and alerts.
- Kill switch: pause new bets on an expiry when the hedger is down, stale, or out of limit.

### 4.4 Data model changes (SQLite, `server/db.ts`)

- `bets`: + `venue`, `instrument_expiry`, `step` (w), `payoff` ('soft' | 'hard'), `fair`, `price_src`.
- `instruments`: venue, underlying, expiry, strike, type, min amount, step, tick, active (refreshed from the venue).
- `surface_snap`: per expiry, the mark, bid, ask and IV for each strike (kept for audit and backtests).
- `exposure`: derived from open bets. Recompute it inside the bet transaction, or keep it as a view.
- `hedge_intents`, `hedge_fills`, `venue_positions` (reconciled snapshots).
- `settlements`: + `source` ('derive' | 'hypercall' | 'coinbase'), so paper markets keep working.

### 4.5 Code touch points

- `shared/pricing.ts`: add `condorLegs()`, `payoffAt()`, `priceFromCurve()`. Keep the lognormal model as the fallback for paper markets.
- `shared/markets.ts`: the series becomes dynamic per asset (venue expiries); paper series stay static.
- `server/feed.ts`: add `venue-derive.ts` and `venue-hypercall.ts` read-only feeds (instrument list, tickers, settlement prices).
- `server/engine.ts`: `placeBet` snaps to the grid, prices off the curve, checks the exposure limit, and writes exposure;
  `settleDue` uses the venue settlement price.
- `src/components/Ladder.tsx` / `Chart.tsx`: strike-grid ladder, shaded ramp zones, venue-implied odds.
- new `hedger/`: its own `package.json` with signing deps, Derive client first.

## 5. Phases, each with exit criteria

**Phase 0: Measure (paper, no keys). About 1 week.**
Read-only venue adapters plus a snapshot recorder (every 30 s, both venues, BTC/ETH, all expiries ≤ 30 days).
A report on spread cost by moneyness, tenor and time of day, and on how often the book is two-sided.
Show "market-implied odds" next to the model odds in the existing paper app.
*Exit:* a typical net hedge costs ≤ ~10% over mark for 2–7 day ranges at the sizes we expect, or a decision that we hedge only as a
maker. If neither holds, stop: the product cannot beat simply quoting wider.

**Phase 1: Venue-priced paper markets. About 1 week.**
Real-money-shaped markets (strike-snapped, venue expiries, soft edges) running on paper money, priced from the curve and settled
on the venue settlement price. Keep the old hourly/4h series labelled "practice".
*Exit:* 2+ weeks of settled paper bets where our settlement price equals the venue's for every expiry.

**Phase 2: Exposure book and risk dashboard. About 1 week.**
The call-vector book, worst-case loss per expiry, the would-be hedge, and inventory-skewed pricing. A shadow hedger computes orders
and logs them but never sends any.
*Exit:* replaying Phase 1 bets through the shadow hedger shows bounded worst-case loss and simulated P&L ≥ 0 after the measured hedge costs.

**Phase 3: Live hedger on Derive testnet. About 2 weeks.**
Session key with only the needed scopes and an IP whitelist; subaccount in the Prime universe (BTC + ETH together); maker-first
execution; intents, fills and reconciliation; kill switch; alerts.
*Exit:* 7 days unattended on testnet with zero unreconciled positions and correct behaviour through an expiry rollover and an
injected venue outage.

**Phase 4: Live hedger with the house's own money, small. About 2 weeks.**
Paper users, real hedges at the minimum size. This is the only way to learn real fills, fees and settlement. Hypercall RFQ V2 is
added here if the jurisdiction allows it, because it has no testnet.
*Exit:* hedge P&L matches the model within tolerance over 4+ weekly expiries.

**Phase 5: Real-money users (gated on the §2 legal answer).**
Wallet auth, deposits/withdrawals, a double-entry ledger, KYC/geo-fencing as counsel requires, rate limits, a payout reserve
sized to worst-case unhedged loss plus venue counterparty risk, and monitoring and on-call.

## 6. Risks and how each one is handled

| Risk | Mitigation |
|---|---|
| Spread cost eats the edge | Net internally, price off mid, hedge only the residual, maker-first; Phase 0 gate |
| Settlement basis (TWAP vs our price) | Settle on the venue's own published price |
| Venue goes down / delists / pends settlement | Pause the expiry, hold bets until the venue settles (Hypercall can pend); disclose this in the terms |
| One-sided flow (everyone bets "in" near spot) | Inventory skew in pricing; per-expiry worst-case-loss caps; refuse bets past the cap |
| Venue counterparty / smart-contract risk | Cap capital per venue; split across venues; withdraw excess daily |
| Key compromise | Separate hedger process, scoped session keys, IP whitelist, short expiry, no withdraw scope on the hot key |
| Rate limits (Derive 20 RFQs/day) | Use the order book for routine hedges; save RFQ for blocks |
| Strike grid shifts or missing strikes | Snap at bet time to listed strikes only; refuse ranges whose legs are not listed |

## 7. Open questions

1. Which jurisdiction are we operating from? (This decides Hypercall and the whole of Phase 5.)
2. Soft-edged ranges (recommended) or hard binaries priced at the super-replication cost?
3. Is the end state real money, or a "market-priced paper" product (Phases 0–2 only), which is useful and legal on its own?
4. Budget for house capital in Phase 4 (the minimum useful amount is roughly $5–10k across BTC/ETH).
