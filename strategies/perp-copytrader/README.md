<div align="center">

# dreamCopy

**Find the best trader on a DreamDEX perp market. Follow them automatically.**

`Somnia Hideki` · `@somnia-chain/markets-sdk` · `TypeScript` · `MIT`

</div>

---

Copy trading is the one feature that makes a new perp venue feel alive: it turns a
market with a handful of good traders into a market everybody can participate in.
dreamCopy does it in two commands, and the first one needs no wallet at all.

```bash
npm run scan  -w perp-copytrader -- ETH    # who is winning, and why
npm run start -w perp-copytrader           # follow the best of them
```

---

## Try it right now — no key, no funding

`scan` is read-only and talks only to the public indexer. Anyone can run it today:

```
dreamCopy  │  leaderboard

▍ ETH-PERP
  mark             2,400.65
  pool             0xd6cb1dd58580b84d76068ac21594219ce03aeddf
  window           last 2,000 fills
  covering         2,000 fills, 1h ago → 2s ago

╭────┬─────────────┬──────────────┬──────────┬──────────┬─────────┬───────────┬────────────┬────────────┬───────┬─────────╮
│  # │ TRADER      │     POSITION │    ENTRY │ REALIZED │ UNREAL. │ TOTAL PNL │            │     VOLUME │ TAKER │    LAST │
├────┼─────────────┼──────────────┼──────────┼──────────┼─────────┼───────────┼────────────┼────────────┼───────┼─────────┤
│  1 │ 0x4753…8bff │  +9.2225 ETH │ 2,409.06 │ +$821.82 │ −$77.52 │  +$744.30 │ ██████████ │ $7,865,219 │   16% │  2s ago │
│  2 │ 0x5ad3…3817 │  +0.8291 ETH │ 2,411.78 │ +$183.08 │  −$9.22 │  +$173.86 │ ██░░░░░░░░ │ $1,281,807 │  100% │ 10s ago │
│  3 │ 0xf428…2f26 │  −3.2181 ETH │ 2,402.99 │   +$0.00 │  +$7.51 │    +$7.51 │ ░░░░░░░░░░ │     $7,733 │  100% │ 29m ago │
│ 12 │ 0x05d4…9dc4 │ +13.4648 ETH │ 2,404.28 │  −$64.71 │ −$48.75 │  −$113.46 │ ██░░░░░░░░ │   $382,120 │   50% │  7m ago │
╰────┴─────────────┴──────────────┴──────────┴──────────┴─────────┴───────────┴────────────┴────────────┴───────┴─────────╯

· top of the window is 0x4753…8bff at +$744.30
  follow it: COPY_LEADER=0x4753… npm run start -w perp-copytrader
```

Run it with no argument to list every perp market on the venue, busiest first.

---

## What the venue does not give you

Two things have to be true for copy trading to work, and neither is served by an
existing endpoint. Both were established against the live indexer, not assumed.

**1. You cannot read another account's position.**
`exchange.fetchPositions()` only ever answers for the signer. A copy trader whose
whole job is watching somebody else has no SDK path to the thing it follows.

**2. The PnL tables are empty for perps.**
`AccountMarketPnl` and `AccountMarketVolume` are prediction-market tables — they
carry `yesQuantity` / `noCost` and return **zero rows** for every perp pool. There
is no leaderboard to read.

So dreamCopy derives both from the one perp-complete source there is: the `Fill`
table. Every account's position, average entry, realised and unrealised PnL is
reconstructed by replaying fills through average-cost accounting.

> One detail that silently breaks naive implementations: on perp fills
> `takerSide` and `makerSide` are **NULL** — they only carry `BUY_YES`/`SELL_YES`
> on prediction markets. `takerIsBid` is the only populated side signal, and the
> maker is by definition on the other side of it.

---

## How it works

dreamCopy mirrors a **position**, not an order feed. Each cycle it recomputes
where it should be, compares that to where it is, and sends the difference.

```
   indexer (Fill rows)                SDK (your account)
           │                                  │
           ▼                                  ▼
   leader's net position            your actual position
           │                                  │
           └──────────────┐    ┌──────────────┘
                          ▼    ▼
              target = leader Δ × ratio, capped
                      gap = target − yours
                          │
                          ▼
              placePerp(gap)  ── when gap ≥ market minimum
```

That single decision is what makes it **self-correcting**. A missed poll, a
partial fill, a rejected order or a full restart all converge on the next cycle,
because the target is recomputed from scratch every time. An implementation that
replays the leader's individual orders drifts permanently the first time one of
them fails — and never notices.

**Live, following a leader on BTC-PERP:**

```
▍ Copy policy
  ratio            10.0% of the leader's size
  cap              $100 max position value
  copying          their moves from now on — not the position they already hold
  poll             6s

▍ Following
12:44:02 leader Δ flat BTC       target flat BTC       ours flat BTC   · in line
12:44:19 leader Δ +0.04871 BTC   target +0.00122 BTC   ours flat BTC   2 new fill(s)  · mirroring long 0.00122 BTC
12:44:28 leader Δ +0.04871 BTC   target +0.00122 BTC   ours +0.00122 BTC  · in line
```

The leader moved 0.04871 BTC; at a 10% ratio that is 0.004871 BTC, but the $100
notional cap binds first and the target lands at 0.00122 BTC. **The cap is doing
its job in the second line** — which is exactly what you want to see before you
ever send a real order.

---

## Configuration

Everything has a safe default. `DRY_RUN` defaults to **true**, so a
misconfigured bot logs what it would do instead of doing it.

| Variable | Default | What it does |
| --- | --- | --- |
| `COPY_LEADER` | *(auto)* | Address to follow. Unset = pick the top of the leaderboard. |
| `COPY_RATIO` | `0.1` | Fraction of the leader's size to mirror. |
| `COPY_MAX_NOTIONAL_USDSO` | `100` | Hard cap on position **value**. The real risk limit. |
| `COPY_FOLLOW_EXISTING` | `false` | `true` mirrors their whole position, not just new moves. |
| `COPY_POLL_MS` | `15000` | How often to check. |
| `COPY_MIN_VOLUME` | `500` | Ignore accounts too small to rank. |
| `COPY_MIN_TAKER_SHARE` | `0.1` | Drop pure market makers — they have no direction to copy. |
| `COPY_SCAN_FILLS` | `2000` | Leaderboard window size. |
| `PERP_SYMBOL` | `BTC-PERP` | Market to trade. |
| `PERP_LEVERAGE` | `2` | Set before sizing, since it is a floor on margin. |
| `DRY_RUN` | `true` | `false` sends real orders. |

Standard kit variables (`NETWORK`, `PRIVATE_KEY`, `OWNER_ADDRESS`) behave exactly
as they do in the other strategies.

---

## Risk controls

Copy trading somebody you have never met is the whole premise, so the limits are
not optional extras:

- **Notional cap** — `COPY_MAX_NOTIONAL_USDSO` bounds position *value*, not
  contract count. A leader who levers up 50× still cannot move you past your cap.
- **Follow forward by default** — the bot does not buy into a position that is
  already deep in profit. It copies what they do *next*.
- **Pool-authoritative sizing** — every order goes through `getMaxPerpOrderSize`,
  so the venue's own rule caps the size and names what capped it. No local
  equity-and-leverage guess that the pool then rejects.
- **Market minimum respected** — gaps below `minQuantity` are left alone instead
  of being rounded into a rejected order.
- **Self-follow refused** — copying your own account compounds your position
  every cycle. The bot detects it and stops.
- **A bad cycle costs one tick** — network and indexer failures are caught; the
  next cycle recomputes the target from scratch.

### Trading keys

dreamCopy works with a linked bot key (`OWNER_ADDRESS`). Orders, margin and fills
belong to your account; the key only signs and pays gas, and **cannot withdraw**.
Link it in the app under *wallet → Link a bot → Perps*.

---

## Install

```bash
npm install                                 # from the repo root
npm run scan  -w perp-copytrader -- ETH     # no key needed
npm run start -w perp-copytrader            # dry run by default
```

Requires Node 20+. `scan` needs only network access; `start` additionally needs a
`PRIVATE_KEY` to place orders.

---

## Honest limits

- **The leaderboard is windowed.** Accounting starts at the first fill in the
  window, so a position opened before it counts from its first in-window fill.
  Widen with `COPY_SCAN_FILLS`. This is stated rather than hidden because it is
  the real limit of ranking from a bounded read.
- **Past performance is not an edge.** The top of a one-hour window may be a
  lucky direction, not a good trader. Longer windows rank more honestly.
- **Following costs the spread.** dreamCopy crosses to mirror promptly, so a
  leader who makes their money providing liquidity is a poor one to copy — which
  is what `COPY_MIN_TAKER_SHARE` exists to filter.

---

<div align="center">
<sub>Built on the DreamDEX bot kit for the Somnia Perps Builder Bounty.</sub>
</div>
