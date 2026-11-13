# { bracket }

Bet where prices settle. Pick BTC, ETH or SOL and a date, draw a price range, and if the settlement price lands inside
it (or outside it, if you bet that way) you get paid stake × multiplier.

The odds come from the real options market. Behind the scenes the house turns every bet into a set of
[Derive](https://derive.xyz) options, nets everyone's bets against each other, and hedges whatever risk is left over.
Users never touch an option.

**Paper trading only.** Every account starts with 10,000 demo USDC. Nothing holds keys or sends orders to any venue.
This is a learning project. `PLAN-hedged.md` has the reasoning and findings.

---

## Quick start

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173.

| Page | URL | What it is |
| --- | --- | --- |
| Landing | `/` | Pick an asset, drag a range on its live distribution, and see the payout |
| Trade | `/#trade` | The trading terminal |
| Desk | `/#desk` | Behind the scenes: the house's book, its hedges, and hedging costs |

To run a production build on one port (:8787):

```sh
pnpm build && pnpm start
```

Other commands: `pnpm typecheck`, and `pnpm report [hours]` (hedge-cost statistics, see below).

---

## What the user sees

1. **Pick a market and a date.** BTC, ETH and SOL use the expiries Derive lists: 08:00 UTC dailies and Friday weeklies,
   out to 30 days.
2. **Draw a range.** Drag on the chart, click ladder rows, or type any two prices.
3. **Get a quote.** The ticket shows the chance of landing in the range, the multiplier, and the payout. "How this is
   priced" shows the fee, the skew, and which options cover the bet.
4. **Settle.** The bet pays if Derive's settlement price (a 30-minute average up to expiry) is inside the range.
   Betting and closing early stop when that 30-minute window starts. Until then you can close early at fair value,
   less the fee.

Gold, NVDA, crude oil and EUR/USD, plus hourly to monthly BTC/ETH/SOL expiries, are still available under
**Practice markets**. They're priced by a simple model and settle on Coinbase (see [Practice markets](#practice-markets)).

---

## How it works

### 1. Pricing a bet

- **Fair value** is the chance the market gives the range. It's read from Derive's option prices for that date:
  the price of a tight call spread tells you the chance of finishing above a strike, and a smooth curve through those
  points gives the chance of landing between any two prices.
- **Multiplier** = (1 − 6% fee) ÷ fair value × inventory skew.
- **Inventory skew** leans against crowded positions. A bet that adds to the house's worst-case loss on that expiry
  pays up to 10% less, and more so the more of the risk limit is already used. A bet that offsets the book pays up to
  1.5% more.
- The server re-prices every bet and rejects it if the multiplier fell more than 2% from what the screen showed.

Code: `shared/options.ts` (`rangeFair`, `rangeQuote`). The browser and server import the same file, so the screen
and the server always agree.

### 2. How the house covers a bet

Every bet maps to a **condor**: four options on listed strikes that pay $1 across a band of prices.

- **Inside** bets are covered by the condor on the strikes just *outside* the range. It pays at least as much as the bet
  at every price.
- **Outside** bets are covered by $1 cash minus the condor on the strikes just *inside* the range, or by cash alone
  if the range is too narrow for one.

So the whole book for an expiry is just "net options held per strike". Bets on opposite sides cancel out.

### 3. Hedging (simulated)

- The house tracks each expiry's **worst-case loss**: the most it could lose at any settlement price, after the stakes
  it collected and the hedges it holds.
- When that passes the risk limit (`RISK_LIMIT`), the hedger works out the trades that would move the book toward
  fully covered, against live Derive bid/ask quotes and fees. It tries 0%, 25%, 50%, 75% and 100% of that move and
  picks the one where worst-case loss plus spread and fees paid is lowest. If no hedge helps more than it costs, the
  house carries the risk.
- Fills are **simulated** and logged. Below the forward price it uses puts plus a perp in place of calls, which is
  how a desk would actually do it.
- At settlement it records how the house did with and without its hedges (Desk → Settled expiries).

Code: `server/options/book.ts`, `server/options/hedger.ts`.

### 4. Measuring hedge costs (research)

Every 10 minutes the server prices a standard set of ranges on every Derive and Hypercall expiry, at fair value and
as a real trade would cost, and stores the result. `pnpm report` prints the summary. The Desk shows the last 24 hours.

The headline finding: Derive charges 0.03% of the underlying's full price on every option, and a condor has four of them,
so fees, not the bid/ask spread, are the biggest hedging cost. That's why the house nets bets first and hedges only
what's left.

### Practice markets

These are the original prototype markets, kept for fun.
- **Pricing:** a flat-vol lognormal model (`shared/pricing.ts`) with a 3% fee.
- **Settlement:** the first Coinbase trade at or after expiry.
- **Data:** BTC/ETH/SOL prices are live from Coinbase. The other assets are simulated random walks, because free
  real-time feeds for them need an API key.

### House pool

Stakes go into one pool and payouts come out of it. A bet is refused if its payout is over 0.5% of the pool, or if the
pool couldn't cover every open payout at once.

---

## Deploy (free, on Render)

`render.yaml` describes one free Render web service that serves both the site and the API.

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick this repo, and click **Apply**.

It builds with `pnpm build`, starts with `pnpm start`, and redeploys on every push to `main`.

Two things to know about the free tier:
- **It would sleep, so it pings itself.** Render's free tier spins down after 15 minutes without visitors. In
  production the server requests its own public URL (`RENDER_EXTERNAL_URL`, which Render sets) every 10 minutes, which
  counts as a visit. Running 24/7 uses ~744 of the 750 free hours a month, so keep this the only free service on the account.
  Set `KEEPALIVE_URL=off` to stop it. If it ever does sleep, the next visit takes about a minute.
- **Data resets.** It has no permanent disk, so paper accounts and bets reset whenever it restarts or redeploys.
  Visitors simply get a fresh 10,000 USDC.

Vercel isn't an option as-is: it runs short-lived functions, and this server needs to stay running for its live feeds,
settlement and hedger, with a database file on disk.

---

## Tech stack

| Part | What we used |
| --- | --- |
| Language | TypeScript everywhere (server, browser, shared pricing) |
| Server | Node 24, plain `node:http`, run directly as `.ts` via Node's built-in type stripping. No framework and no runtime dependencies |
| Database | SQLite via Node's built-in `node:sqlite`. Money is stored in integer cents |
| Live updates | Server-Sent Events (prices every 500 ms, curves and books every 5 s) |
| Frontend | React 19 + Vite 8. Charts are hand-drawn on `<canvas>` and SVG, with no chart library |
| Styling | One plain CSS file (`src/styles.css`) with color tokens at the top. Inter font |
| Market data | Coinbase public REST + WebSocket (spot); Derive v3 public JSON-RPC (options, settlement prices); Hypercall public REST (research only) |
| Package manager | pnpm |

---

## Project layout

```
shared/            Imported by both server and browser
  options.ts         range pricing, condors, book maths, skew
  pricing.ts         practice-market model
  markets.ts         assets and practice expiry schedules
  types.ts           API types
server/
  index.ts           HTTP routes, SSE stream, startup
  engine.ts          place / close / settle bets
  db.ts              SQLite schema and queries
  feed.ts            Coinbase feed and simulated markets
  options/
    venues.ts          Derive + Hypercall read-only adapters
    chains.ts          polling, option chain → pricing curve
    book.ts            the house book for each expiry
    hedger.ts          shadow hedger
    exec.ts            trading costs and fees
    research.ts        hedge-cost sampling
src/
  App.tsx            routing and the trading terminal
  components/        Landing, Chart, Ladder, Ticket, Positions, Desk, Nav
  styles.css         all styles and color tokens
scripts/
  dev.mjs            runs API + Vite together
  report.ts          hedge-cost report
```

---

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | API / app port |
| `DB_PATH` | `data/bracket.db` | SQLite file |
| `START_BALANCE` | `10000` | Demo USDC for new accounts |
| `POOL_START` | `2000000` | House pool seeded on first run |
| `MAX_PAYOUT_FRACTION` | `0.005` | Largest single payout, as a fraction of the pool |
| `RISK_LIMIT` | `10000` | Worst-case loss per expiry before the hedger acts (try `2000` to see it trade) |
| `OPT_MAX_DAYS` | `30` | Furthest Derive expiry offered |
| `OPT_OFF` | unset | `1` turns off Derive/Hypercall (practice markets only, works offline) |
| `KEEPALIVE_URL` | `RENDER_EXTERNAL_URL` | URL the production server pings every 10 min to stay awake on a free host; `off` disables it |
| `HYPERCALL_OFF` | unset | `1` stops polling Hypercall (set on the public deploy, since its terms bar redistributing its data) |
| `SIM_ONLY` | unset | `1` simulates every market instead of using Coinbase |
| `SAMPLE_MS` / `SAMPLE_KEEP_DAYS` | `600000` / `14` | Hedge-cost sampling interval and retention (~3 MB a day) |

---

## API

Logged-in routes take `Authorization: Bearer <token>` (from `POST /api/session`).

| Route | Returns |
| --- | --- |
| `POST /api/session` | A new paper account: `{ token, account }` |
| `GET /api/me` · `POST /api/me/reset` | Your account, open bets and history · reset your balance |
| `POST /api/bets` | Place a bet: `{ sym, series, side, lo, hi, stake, minMult }`. Derive expiries use `series: "opt:<expiry ms>"` |
| `POST /api/bets/:id/close` | Close early: `{ minValue }` |
| `GET /api/markets` | Assets, practice expiries, pool, server time |
| `GET /api/opt` | Derive expiries with their pricing curve and house book |
| `GET /api/candles?sym=BTC&gran=900` | Price candles (`gran`: 60, 300, 900, 3600, 21600 s) |
| `GET /api/stream?token=…` | SSE events: `prices`, `curves`, `account` |
| `GET /api/recent` | Latest 24 bets from everyone |
| `GET /api/leaderboard` | Top 25 by equity |
| `GET /api/desk` | Hedge costs, books, shadow positions and fills, settled results |

---

## Not built (on purpose)

This stops at simulated hedging. A real-money version would still need:
- **Accounts and money:** wallets and deposits/withdrawals.
- **Real hedging:** real order placement on Derive, with key management.
- **Protection and accounting:** rate limiting, a proper ledger, and monitoring.
- **Legal review:** selling range bets for real money is regulated almost everywhere, and Hypercall's terms exclude
  US persons.
