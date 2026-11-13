// Phase 0 report: what hedging range bets costs on each venue, from the samples the server records.
// Usage: pnpm report [hours]   (default: everything kept, see SAMPLE_KEEP_DAYS)
import { config } from '../server/config.ts';
import { spreadSummary } from '../server/options/research.ts';

const hours = Number(process.argv[2]) || config.sampleKeepDays * 24;
const rows = spreadSummary(Date.now() - hours * 3_600_000);
if (!rows.length) {
  console.log('No samples yet. Run the server (pnpm dev or pnpm start) and wait for the first sample.');
  process.exit(0);
}
const p = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
console.log(`Hedge cost over the last ${hours}h. Markups and fees are relative to the condor's mark value.`);
console.log('Buy = buying the condor (after selling "inside" bets); sell = selling it (after "outside" bets).\n');
console.table(rows.map(r => ({
  venue: r.venue, sym: r.sym, tenor: r.tenor, range: r.shape, quotes: r.quoteKind, n: r.n,
  executable: p(r.executable), mark: r.mark.toFixed(3), buy: p(r.buyMarkup), sell: p(r.sellMarkup), fees: p(r.fee),
})));

// Go/no-go from PLAN-hedged.md: is a 2–7 day net hedge within ~10% over mark (spread + fees)?
const gate = rows.filter(r => r.venue === 'derive' && (r.tenor === '1–3d' || r.tenor === '3–7d') && r.buyMarkup != null && r.sellMarkup != null);
if (gate.length) {
  const cost = gate.map(r => (r.buyMarkup! + r.sellMarkup!) / 2 + r.fee).sort((a, b) => a - b);
  const med = cost[cost.length >> 1];
  console.log(`\nDerive, 2–7 day ranges: median taker cost (spread + fees) ≈ ${p(med)} of mark.`
    + ` Phase 0 gate (≤ 10%): ${med <= 0.1 ? 'PASS' : 'FAIL — hedge only the net residual, as a maker, or quote wider'}.`);
}
