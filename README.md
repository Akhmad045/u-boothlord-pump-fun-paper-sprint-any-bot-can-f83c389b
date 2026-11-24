[![Pump.fun Paper Sprint](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Akhmad045/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Akhmad045/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint Bot

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. Paper money only — no real funds, no wallet, no network calls. One program, `main.ts`, runs on Node 22 and speaks the `agent-fun/replay/v2` harness protocol over stdin/stdout.

Referral code: `4g7knchf`

## The strategy

Wait for proof, then get out fast. A freshly listed coin is bought only once
it has already risen 50% above its listing price on real buying (at least 6
buys, listed within the last ~16 minutes, holding at least 3 SOL of real
reserves), and never above twice its listing price. The buy is small — at most
0.25 SOL, and usually much less, because each reply may only spend 1% of the
coin's real SOL reserves.

The whole position is sold at the first of:

- **+25%** over the entry price (take profit),
- **−8%** under the entry price (stop loss),
- **−10% from the peak** once the price has peaked at least +20% over entry
  (trailing give-back),
- **600 slots** (~4 minutes) after entry, whatever the price is.

Each coin is bought at most once, at most 5 positions are open at a time, and
a coin with a sell already in flight gets no duplicate sell order.

## Why this shape

On the kit's dev window, new coins usually spike inside a single slot and
then fade back toward their listing price, while a bot only sees
end-of-slot prices and fills two slots later — so chasing the first spike
means buying the top. Waiting for a 50% rise filters out the one-slot
wonders, and the exits stay tight because a coin that has not paid off
within a few minutes almost never does. The dev grade for this bot is
−0.98 SOL on the 24-hour dev window (287 coins traded, 10.4% maximum
drawdown, inside the 50% guardrail), against −4.04 SOL for an earlier
version that entered at +25% with wide exits.

## How it works

`main.ts` is plain erasable TypeScript with no dependencies. It imports the
kit's bot shim from `vendor/makefun-bot.ts`, which owns the wire protocol:
one JSON line in per batch (`hello`, `batch`, `done`), exactly one reply
line out per batch. The strategy keeps one small record per coin it has
seen (listing price and slot, latest price, buy count, entry price and
slot, peak since entry) and decides only from that record, the harness
state, and slot numbers. There is no clock, no randomness, no environment
read, and no network access, so two runs on the same data produce the
same orders byte for byte. All price comparisons are exact `BigInt`
cross-multiplication on bonding-curve reserves (price = virtual quote
reserves / virtual token reserves), never floating point.

## Files

- `main.ts` — the strategy (the entrypoint).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, copied
  unchanged from the kit's SDK.
- `LICENSE` — MIT.

## Local check

Grade it on the dev window the way the server does (no Docker needed;
`process` runs the bot on this machine):

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## License

MIT. See `LICENSE`.
