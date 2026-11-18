# BTC Breakout-Trend Bot — make.fun `btc-race-24h-20261118-1444`

[![competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Jeytm/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Jeytm/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A disciplined, long-only trading bot for the [make.fun](https://make.fun/bounty/btc-race-24h-20261118-1444) competition **"Race a BTC trading bot live for 24 hours"**. It trades Coinbase Wrapped BTC (CBBTC) against paper USDC on 1-minute bars, speaking the `agent-fun/bars-replay/v1` protocol: one JSON line in per minute, one reply out. Nothing here trades real money.

## Strategy

The replay charges roughly 26–36 bps per full-size round trip (4 bps fee, 2 bps slippage, plus price impact against the pool), so a trade has to catch a move well above that to pay. The bot therefore trades rarely — only when a genuine trend episode shows up — and lets each position run for hours instead of minutes.

**Entry** (all conditions on the same bar, while flat):

- The latest close breaks above the highest close of the previous 90 bars (a Donchian-style breakout on closes).
- The 12-bar EMA is above the 120-bar EMA (trend filter).
- At least 60 bars have passed since the last exit (cooldown).
- The drawdown guard has not tripped.

The bot buys with its full cash balance, capped at what the weight cap admits, with a 100 bps maximum-slippage limit.

**Exits** (whichever comes first, whole position sold):

- **Trailing stop:** close falls 90 bps below the highest close seen while holding.
- **Hard stop:** position value at the close falls 120 bps below its cost.
- **Time stop:** 180 bars held.

**Drawdown guard:** if equity ever falls 8% below its running peak, the bot stops opening new positions for the rest of the window. Exits keep running either way.

## Why this shape

On the frozen 24-hour dev window (17–18 Nov 2026, BTC down about 280 bps), every fast baseline lost money when graded locally with the kit harness: the EMA-crossover baseline −$148.17 over 80 trades, ADX momentum −$75.57 over 30 trades, RSI/Bollinger −$39.92 over 19 trades, momentum −$23.87, and buy-and-hold −$31.63. They all paid more in round-trip costs than they caught. The breakout-plus-trend filter with wide stops and long holds was the shape that survived a parameter sweep: it stayed profitable across a broad neighborhood of nearby settings rather than at one tuned peak, which is what matters when the race window is unseen data.

## Determinism

Two executions on the same data must produce the same orders, byte for byte. The bot's only floating-point math is the two EMAs, which use only `+ - * /` on float64 values — each operation correctly rounded under IEEE 754. Every other comparison is exact bigint arithmetic on the integer prices the bars carry. There is no wall clock, no randomness, no network access, and no file I/O: decisions depend only on the bars and the account the harness sends.

## Layout

- `main.ts` — the bot. TypeScript, erasable syntax, runs under Node type stripping (`node /bot/main.ts`).
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's TypeScript SDK shim, kept under `vendor/` as the rules allow.

## Local verification

Graded locally with the kit's own harness (process driver, worktree), from the repository root, with `$KIT` set to the extracted kit directory:

```
node "$KIT/cli/makefun.mjs" grade-local --kit "$KIT" --bot . --driver process --worktree
```

Verified result on the dev window: **net PnL +12.729888 USDC, 4 trades, max drawdown 1.04%, 0 rejected orders**, guardrails met, and the L1 regrade reproduced the action log byte for byte. That is the dev window only — the race window is 24 hours nobody has seen, and a dev profit does not promise a race profit.

## License

MIT — see [LICENSE](LICENSE).
