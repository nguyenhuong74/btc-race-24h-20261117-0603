// Dip-swing bot for cbBTC/USDC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea: on this market the price wanders in a wide band with slow multi-hour
// grinds and occasional sharp steps. Chasing every 1-minute wiggle loses money
// to the ~26 bps round-trip cost, so this bot trades rarely and only on deep
// pullbacks, then lets the position run:
//
//   - Entry (flat only): the close is at least DIP_BPS below the highest close
//     of the last WINDOW_BARS bars, and the 15-bar return is no worse than
//     CONFIRM_BPS (the fall has stopped accelerating: no catching a knife
//     mid-plunge). Buys with all available cash.
//   - Exit (whole position): take profit at TAKE_PROFIT_BPS over the entry
//     cost, stop loss at STOP_LOSS_BPS under it, a trailing stop of TRAIL_BPS
//     below the best value seen since entry, or a time stop after
//     MAX_HOLD_BARS bars held.
//   - Risk caps: after MAX_LOSSES losing round trips the bot stops trading
//     for the rest of the window, and it opens no new trade once equity has
//     fallen below $950, so a grinding downtrend cannot bleed it trade
//     after trade. One position at a time, long only, full size.
//
// Everything is a pure function of the bars the harness sends: no clock, no
// network, no randomness, no files. The same bars always give the same orders.

import {
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WINDOW_BARS = 120;
const DIP_BPS = 120;
const TAKE_PROFIT_BPS = 200;
const STOP_LOSS_BPS = 150;
const TRAIL_BPS = 100;
const CONFIRM_BPS = -10;
const CONFIRM_BARS = 15;
const MAX_HOLD_BARS = 360;
const MAX_LOSSES = 2;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;
/** Stop opening new trades once equity has fallen this far from the start. */
const EQUITY_FLOOR_QUOTE_UNITS = 950_000_000n;

// Closes seen so far, oldest first (one entry per CBBTC bar received).
const closes: number[] = [];

// Position bookkeeping, filled in from the fills each batch reports.
// NOTE: a fill's decided_bar is the bar's timestamp in ms, not its seq, so
// the entry seq is recorded when the buy order is sent (see below), never
// from a fill.
let entryCost = 0n; // quote units spent on the open buy (fee included)
let entrySeq = -1; // seq of the batch that sent the open buy
let peakValue = 0n; // best position value (quote units) since entry
let losses = 0; // losing round trips closed so far

function rollingHigh(): number {
  let high = 0;
  const start = closes.length - WINDOW_BARS;
  for (let i = start; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

function entrySignal(state: BarsState): boolean {
  if (closes.length <= WINDOW_BARS) return false;
  if (losses >= MAX_LOSSES) return false;
  if (state.equity < EQUITY_FLOOR_QUOTE_UNITS) return false;
  const close = closes[closes.length - 1]!;
  const high = rollingHigh();
  const dipBps = ((high - close) / high) * 10000;
  if (dipBps < DIP_BPS) return false;
  if (closes.length <= CONFIRM_BARS) return false;
  const ago = closes[closes.length - 1 - CONFIRM_BARS]!;
  const retBps = ((close - ago) / ago) * 10000;
  return retBps >= CONFIRM_BPS;
}

function exitSignal(state: BarsState): boolean {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || entryCost === 0n) return false;
  const value = state.value(SYMBOL, held.qty);
  if (value > peakValue) peakValue = value;
  const gainBps = ((value - entryCost) * BPS) / entryCost;
  if (gainBps >= BigInt(TAKE_PROFIT_BPS)) return true;
  if (gainBps <= -BigInt(STOP_LOSS_BPS)) return true;
  if (peakValue > 0n) {
    const trailBps = ((peakValue - value) * BPS) / peakValue;
    if (trailBps >= BigInt(TRAIL_BPS)) return true;
  }
  if (entrySeq >= 0 && state.seq - entrySeq >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch: Batch) {
    // Fold in this batch's fills before deciding: a buy fill opens the
    // position (record its cost and the seq that decided it), a sell fill
    // closes it (a losing round trip counts toward the loss cap).
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryCost = BigInt(fill.notional_quote_units);
        peakValue = 0n;
      } else {
        const proceeds =
          BigInt(fill.notional_quote_units) - BigInt(fill.fee_quote_units);
        if (entryCost > 0n && proceeds < entryCost) losses += 1;
        entryCost = 0n;
        entrySeq = -1;
        peakValue = 0n;
      }
    }

    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (exitSignal(state)) {
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          } satisfies SellInput,
        ];
      }
      return [];
    }

    if (entrySignal(state) && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
      // Record the entry seq here: the fill that comes back reports
      // decided_bar as a millisecond timestamp, not this seq.
      entrySeq = state.seq;
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        } satisfies BuyInput,
      ];
    }
    return [];
  },
});
