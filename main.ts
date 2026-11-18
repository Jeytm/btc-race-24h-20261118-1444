// Breakout-trend bot for the BTC 24h race (agent-fun/bars-replay/v1).
//
// Strategy: long only, one position at a time, full size, very few trades.
// The replay charges about 26-36 bps per round trip (4 bps fee, 2 bps
// slippage, plus price impact), so a trade must catch a move well above
// that. The bot therefore waits for a genuine trend episode instead of
// trading every wiggle:
//
//   - Entry: the latest close breaks above the highest close of the
//     previous 90 bars AND the 12-bar EMA sits above the 120-bar EMA.
//     Both conditions must hold on the same bar, the bot must be flat,
//     at least 60 bars must have passed since the last exit, and the
//     drawdown guard must not have tripped.
//   - Exits (whichever comes first): a 90 bps trailing stop below the
//     highest close seen while holding, a 120 bps hard stop against the
//     position's cost, or 180 bars held. The whole position is sold.
//   - Drawdown guard: if equity ever falls 8% below its running peak,
//     no new entries for the rest of the window. Exits still run.
//
// Determinism: the only floating-point math is the two EMAs, which use
// only + - * / on float64 values, each correctly rounded (IEEE 754), so
// the same bars always give the same orders. Every other comparison is
// exact bigint arithmetic on the integer prices the bars carry. No wall
// clock, no randomness, no network, no files: decisions depend only on
// the bars and the account the harness sends.

import { runBars, type BarsState, type Batch, type OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const FAST_SPAN = 12;
const SLOW_SPAN = 120;
const BREAKOUT_BARS = 90;
const TRAIL_BPS = 90n;
const STOP_BPS = 120n;
const MAX_HOLD_BARS = 180;
const COOLDOWN_BARS = 60;
const DRAWDOWN_GUARD_BPS = 800n;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10_000n;
const MIN_NOTIONAL = 1_000_000n; // $1 in quote units: the smallest legal buy.

// Exponential moving average over closes, seeded with the mean of its
// first span closes. Float64, + - * / only: deterministic across runs.
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
    e.warm = [];
  }
}

// Bot state. One run per process, so module state is the whole memory.
const closes: bigint[] = [];
const fast = makeEma(FAST_SPAN);
const slow = makeEma(SLOW_SPAN);
let peakClose: bigint | null = null; // highest close seen while holding
let entrySeq: number | null = null; // seq of the batch that decided the buy
let cooldownUntilSeq = -1; // no entries before this seq
let peakEquity = 0n;
let guardTripped = false;

// The highest close of the `n` bars before the latest one. The latest
// close is closes[len - 1]; the window is closes[len - 1 - n .. len - 2].
function priorMaxCloses(n: number): bigint {
  let priorMax = closes[closes.length - 1 - n]!;
  for (let i = closes.length - n; i < closes.length - 1; i++) {
    if (closes[i]! > priorMax) priorMax = closes[i]!;
  }
  return priorMax;
}

function onBatch(state: BarsState, batch: Batch): readonly OrderInput[] {
  // Fold in every fresh bar for the symbol, in order, including warm-up
  // bars: the indicators must be warm when the scored window starts.
  let freshClose: bigint | null = null;
  for (const bar of batch.bars) {
    if (bar.symbol !== SYMBOL) continue;
    const close = BigInt(bar.c);
    closes.push(close);
    emaStep(fast, Number(bar.c));
    emaStep(slow, Number(bar.c));
    freshClose = close;
  }
  if (state.warmingUp) return [];
  if (freshClose === null) return []; // gap minute: no new information.

  // Drawdown guard: latch once equity falls 8% below its running peak.
  // It blocks new entries only; exits keep running either way.
  if (state.equity > peakEquity) peakEquity = state.equity;
  if (state.equity * BPS < peakEquity * (BPS - DRAWDOWN_GUARD_BPS)) {
    guardTripped = true;
  }

  const close = freshClose;
  const held = state.positions.get(SYMBOL);

  if (held !== undefined && held.qty > 0n) {
    if (peakClose === null || close > peakClose) peakClose = close;
    const value = state.value(SYMBOL, held.qty);
    const trailHit = close * BPS < peakClose * (BPS - TRAIL_BPS);
    const stopHit = value * BPS <= held.cost * (BPS - STOP_BPS);
    const aged = entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS;
    if (trailHit || stopHit || aged) {
      // Exit the whole position. peakClose/entrySeq are left in place:
      // if this sell is rejected the position keeps its true peak and
      // the exit simply re-fires on the next fresh bar. The next buy
      // overwrites both. The cooldown is re-set on every exit decision,
      // so it always counts from the latest one.
      cooldownUntilSeq = state.seq + COOLDOWN_BARS;
      return [{ side: "sell", symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: enter only on a fresh breakout with the trend filter green.
  if (guardTripped) return [];
  if (state.seq < cooldownUntilSeq) return [];
  if (closes.length <= SLOW_SPAN) return []; // slow EMA not seeded yet
  if (fast.value === null || slow.value === null || !(fast.value > slow.value)) return [];
  if (!(close > priorMaxCloses(BREAKOUT_BARS))) return [];
  // Full size, capped at what the weight cap admits: with the cap at
  // 100% this is exactly the cash balance; the cap keeps the order
  // legal if the harness ever runs a tighter one.
  const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
  if (notional < MIN_NOTIONAL) return [];
  entrySeq = state.seq;
  peakClose = close;
  return [{ side: "buy", symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({ onBatch });
