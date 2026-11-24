// Pump.fun paper sprint bot: buy a coin only after it has already proved it
// can run, then take a quick profit or cut a small loss and move on.
//
// Idea, in one sentence: wait until a freshly listed coin has risen half
// again above its listing price on real buying, buy a small slice, then sell
// the whole position at the first of a modest profit target, a tight stop
// loss, a trailing give-back, or a short time limit, and never touch that
// coin again.
//
// Why this shape fits a six-hour window: the dev data says most new coins
// spike inside a single slot and then fade back toward their listing price,
// and a bot only sees end-of-slot prices and fills two slots later, so
// chasing the first spike means buying the top. Waiting for a 50% rise
// filters out the one-slot wonders, and the exits are kept tight because
// the same data says a coin that has not paid off within a few minutes
// almost never does. Small buys, many coins, quick exits.
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
const ENTER_GAIN_NUM = 3n;
const ENTER_GAIN_DEN = 2n; // 1.5x
// ...but not if it already ran this far; a coin that far up is usually done.
const ENTER_MAX_GAIN_NUM = 2n;
const ENTER_MAX_GAIN_DEN = 1n; // 2x
// Need at least this many buys on the coin before trusting the move.
const ENTER_MIN_BUYS = 6;
// Only coins listed within this many slots (~16 minutes at ~2.5 slots/s).
const ENTER_MAX_AGE_SLOTS = 2400;
// The coin must already hold at least this much real SOL, so the 1%-of-reserve
// size cap still lets us buy a meaningful amount (the guardrail counts a
// round trip only when the buy spent at least 0.01 SOL).
const ENTER_MIN_REAL_SOL = 3_000_000_000n;
// Aim to spend this much per buy; the reserve cap usually binds first.
const BUY_TARGET_LAMPORTS = 250_000_000n;
// Never send a buy smaller than this (fees would eat it and it would not
// count toward the 20-coin round-trip bar anyway).
const BUY_MIN_LAMPORTS = 12_000_000n;
// Sell everything at +25% over the entry price.
const TAKE_PROFIT_NUM = 5n;
const TAKE_PROFIT_DEN = 4n; // 1.25x
// Sell everything at -8% under the entry price.
const STOP_LOSS_NUM = 23n;
const STOP_LOSS_DEN = 25n; // 0.92x
// Once the price has peaked at least +20% over entry, sell if it gives back
// 10% from that peak.
const TRAIL_PEAK_NUM = 6n;
const TRAIL_PEAK_DEN = 5n; // 1.2x
const TRAIL_KEEP_NUM = 9n;
const TRAIL_KEEP_DEN = 10n; // 0.9x of peak
// Sell whatever is left after this many slots (~4 minutes).
const MAX_HOLD_SLOTS = 600;
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
  // A coin with a sell already in flight gets no second sell order: the
  // first one fills or is rejected, and a duplicate would only be rejected
  // for insufficient tokens.
  const sellPending = new Set<string>();
  for (const pending of state.pending.values()) {
    if (pending.order.side === "sell") sellPending.add(pending.order.mint);
  }
  for (const [mint, holding] of state.positions) {
    const coin = coins.get(mint);
    if (coin === undefined || !coin.entered) continue;
    if (sellPending.has(mint)) continue;
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
