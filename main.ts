// Pump.fun paper sprint bot: catch a coin early while it is climbing, get out fast.
//
// Idea, in one sentence: buy a freshly listed coin once its price has already
// risen a quarter above its listing price on real buying, then sell the whole
// position at the first of a profit target, a stop loss, a trailing give-back,
// or a short time limit, and never touch that coin again.
//
// Why this shape fits a six-hour window: most new coins either run up quickly
// and then fade back toward their listing price or die outright, so holding
// anything for long gives the gains back. Small buys, many coins, quick exits.
//
// All decisions come from the harness state and slot numbers only. No clock,
// no randomness, no network, no environment reads, so two runs on the same
// data produce the same orders byte for byte.
//
// Prices are bonding-curve prices: quote per token = virtual quote reserves /
// virtual token reserves. Every comparison is exact BigInt cross
// multiplication, never floating point.
import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

// --- tuning knobs (all in plain sight, change them and re-grade) ---

// Enter when the price is at least this far above the listing price...
const ENTER_GAIN_NUM = 5n;
const ENTER_GAIN_DEN = 4n; // 1.25x
// ...but not if it already ran this far; a coin that far up is usually done.
const ENTER_MAX_GAIN_NUM = 2n;
const ENTER_MAX_GAIN_DEN = 1n; // 2x
// Need at least this many buys on the coin before trusting the move.
const ENTER_MIN_BUYS = 4;
// Only coins listed within this many slots (~10 minutes at ~2.5 slots/s).
const ENTER_MAX_AGE_SLOTS = 1500;
// The coin must already hold at least this much real SOL, so the 1%-of-reserve
// size cap still lets us buy a meaningful amount (the guardrail counts a
// round trip only when the buy spent at least 0.01 SOL).
const ENTER_MIN_REAL_SOL = 2_000_000_000n;
// Aim to spend this much per buy; the reserve cap usually binds first.
const BUY_TARGET_LAMPORTS = 250_000_000n;
// Never send a buy smaller than this (fees would eat it and it would not
// count toward the 20-coin round-trip bar anyway).
const BUY_MIN_LAMPORTS = 12_000_000n;
// Sell everything at +60% over the entry price.
const TAKE_PROFIT_NUM = 8n;
const TAKE_PROFIT_DEN = 5n; // 1.6x
// Sell everything at -25% under the entry price.
const STOP_LOSS_NUM = 3n;
const STOP_LOSS_DEN = 4n; // 0.75x
// Once the price has peaked at least +40% over entry, sell if it gives back
// 15% from that peak.
const TRAIL_PEAK_NUM = 7n;
const TRAIL_PEAK_DEN = 5n; // 1.4x
const TRAIL_KEEP_NUM = 17n;
const TRAIL_KEEP_DEN = 20n; // 0.85x of peak
// Sell whatever is left after this many slots (~8 minutes).
const MAX_HOLD_SLOTS = 1200;
// Reject a fill whose price is worse than the decision price by more than this.
const SLIPPAGE_BPS = 500;

const SOL = LAMPORTS_PER_SOL;

// One line of memory per coin we have ever seen in a delivered event.
interface Coin {
  createdSlot: number;
  // Listing price, as a ratio createVq / createVt.
  createVq: bigint;
  createVt: bigint;
  // Latest known price, as a ratio lastVq / lastVt.
  lastVq: bigint;
  lastVt: bigint;
  buys: number;
  complete: boolean;
  // True once a buy order has been sent for this mint (we buy each coin once).
  entered: boolean;
  // Entry price, as a ratio entryVq / entryVt, and the slot we decided to buy.
  entryVq: bigint;
  entryVt: bigint;
  entrySlot: number;
  // Highest price seen since entry, as a ratio peakVq / peakVt.
  peakVq: bigint;
  peakVt: bigint;
}

// priceA >= (num/den) * priceB, with prices as (vq, vt) ratios. Exact.
function atLeast(
  aVq: bigint,
  aVt: bigint,
  num: bigint,
  den: bigint,
  bVq: bigint,
  bVt: bigint,
): boolean {
  return aVq * den * bVt >= num * bVq * aVt;
}

// priceA <= (num/den) * priceB. Exact.
function atMost(
  aVq: bigint,
  aVt: bigint,
  num: bigint,
  den: bigint,
  bVq: bigint,
  bVt: bigint,
): boolean {
  return aVq * den * bVt <= num * bVq * aVt;
}

// priceA > priceB, as (vq, vt) ratios. Exact.
function above(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint): boolean {
  return aVq * bVt > bVq * aVt;
}

const coins = new Map<string, Coin>();

function noteCreate(mint: string, slot: number, vq: bigint, vt: bigint): void {
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      createdSlot: slot,
      createVq: vq,
      createVt: vt,
      lastVq: vq,
      lastVt: vt,
      buys: 0,
      complete: false,
      entered: false,
      entryVq: 0n,
      entryVt: 1n,
      entrySlot: 0,
      peakVq: 0n,
      peakVt: 1n,
    };
    coins.set(mint, coin);
  }
}

function noteTrade(
  mint: string,
  slot: number,
  vq: bigint,
  vt: bigint,
  isBuy: boolean,
): void {
  let coin = coins.get(mint);
  if (coin === undefined) {
    // First seen through a trade: treat first sight as the listing point.
    coin = {
      createdSlot: slot,
      createVq: vq,
      createVt: vt,
      lastVq: vq,
      lastVt: vt,
      buys: 0,
      complete: false,
      entered: false,
      entryVq: 0n,
      entryVt: 1n,
      entrySlot: 0,
      peakVq: 0n,
      peakVt: 1n,
    };
    coins.set(mint, coin);
  }
  coin.lastVq = vq;
  coin.lastVt = vt;
  if (isBuy) coin.buys += 1;
  if (coin.entered && above(vq, vt, coin.peakVq, coin.peakVt)) {
    coin.peakVq = vq;
    coin.peakVt = vt;
  }
}

function onBatch(state: BotState, batch: Batch) {
  // Fold this batch's events into our per-coin memory, and remember which
  // coins moved, so entry checks only touch coins whose price just changed.
  const moved = new Set<string>();
  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      noteCreate(
        event.mint,
        event.slot,
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
    } else if (event.event === "TradeEvent") {
      noteTrade(
        event.mint,
        event.slot,
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
        event.is_buy,
      );
      moved.add(event.mint);
    } else {
      const coin = coins.get(event.mint);
      if (coin !== undefined) coin.complete = true;
    }
  }

  const orders: OrderInput[] = [];

  // Exits first: every held position is checked against its exit rules.
  for (const [mint, holding] of state.positions) {
    const coin = coins.get(mint);
    if (coin === undefined || !coin.entered) continue;
    const peakedHigh = atLeast(
      coin.peakVq,
      coin.peakVt,
      TRAIL_PEAK_NUM,
      TRAIL_PEAK_DEN,
      coin.entryVq,
      coin.entryVt,
    );
    const gaveBack = peakedHigh &&
      atMost(
        coin.lastVq,
        coin.lastVt,
        TRAIL_KEEP_NUM,
        TRAIL_KEEP_DEN,
        coin.peakVq,
        coin.peakVt,
      );
    const takeProfit = atLeast(
      coin.lastVq,
      coin.lastVt,
      TAKE_PROFIT_NUM,
      TAKE_PROFIT_DEN,
      coin.entryVq,
      coin.entryVt,
    );
    const stoppedOut = atMost(
      coin.lastVq,
      coin.lastVt,
      STOP_LOSS_NUM,
      STOP_LOSS_DEN,
      coin.entryVq,
      coin.entryVt,
    );
    const tooOld = batch.slot - coin.entrySlot >= MAX_HOLD_SLOTS;
    if (takeProfit || stoppedOut || gaveBack || tooOld) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  // Entries: only coins that traded in this batch, only while a slot is free.
  const maxPositions = state.hello.caps.max_open_positions;
  const txFee = state.txFeeLamports();
  for (const mint of moved) {
    if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= maxPositions) break;
    const coin = coins.get(mint);
    if (coin === undefined) continue;
    if (coin.complete || coin.entered) continue;
    if (coin.buys < ENTER_MIN_BUYS) continue;
    if (batch.slot - coin.createdSlot > ENTER_MAX_AGE_SLOTS) continue;
    if (
      !atLeast(
        coin.lastVq,
        coin.lastVt,
        ENTER_GAIN_NUM,
        ENTER_GAIN_DEN,
        coin.createVq,
        coin.createVt,
      )
    ) continue;
    if (
      !atMost(
        coin.lastVq,
        coin.lastVt,
        ENTER_MAX_GAIN_NUM,
        ENTER_MAX_GAIN_DEN,
        coin.createVq,
        coin.createVt,
      )
    ) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.real_quote_reserves < ENTER_MIN_REAL_SOL) continue;
    const cap = state.maxBuyLamports(mint);
    let size = BUY_TARGET_LAMPORTS;
    if (size > cap) size = cap;
    const free = state.freeCashLamports() - txFee;
    if (size > free) size = free;
    if (size < BUY_MIN_LAMPORTS) continue;
    coin.entered = true;
    coin.entryVq = coin.lastVq;
    coin.entryVt = coin.lastVt;
    coin.entrySlot = batch.slot;
    coin.peakVq = coin.lastVq;
    coin.peakVt = coin.lastVt;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: SLIPPAGE_BPS,
    });
  }

  return orders;
}

await runBot({ onBatch });
