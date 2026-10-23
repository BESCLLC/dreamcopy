<div align="center">

# dreamCopy

**Find the best trader on a DreamDEX perp market. Follow them automatically.**

`Somnia Hideki` · `@somnia-chain/markets-sdk` · `TypeScript` · `31 tests passing`

[**Full documentation →**](strategies/perp-copytrader/README.md)

</div>

---

Copy trading is the feature that makes a young perp venue feel alive: it turns a
market with a handful of good traders into one everybody can take part in.
dreamCopy does it in two commands — and the first needs no wallet at all.

```bash
npm install
npm run scan  -w perp-copytrader -- ETH    # who is winning, and why
npm run start -w perp-copytrader           # follow the best of them
```

```
dreamCopy  │  leaderboard

▍ ETH-PERP
  mark             2,400.65
  window           last 2,000 fills

╭────┬─────────────┬──────────────┬──────────┬──────────┬─────────┬───────────┬────────────┬────────────┬───────╮
│  # │ TRADER      │     POSITION │    ENTRY │ REALIZED │ UNREAL. │ TOTAL PNL │            │     VOLUME │ TAKER │
├────┼─────────────┼──────────────┼──────────┼──────────┼─────────┼───────────┼────────────┼────────────┼───────┤
│  1 │ 0x4753…8bff │  +9.2225 ETH │ 2,409.06 │ +$821.82 │ −$77.52 │  +$744.30 │ ██████████ │ $7,865,219 │   16% │
│  2 │ 0x5ad3…3817 │  +0.8291 ETH │ 2,411.78 │ +$183.08 │  −$9.22 │  +$173.86 │ ██░░░░░░░░ │ $1,281,807 │  100% │
│  3 │ 0xf428…2f26 │  −3.2181 ETH │ 2,402.99 │   +$0.00 │  +$7.51 │    +$7.51 │ ░░░░░░░░░░ │     $7,733 │  100% │
╰────┴─────────────┴──────────────┴──────────┴──────────┴─────────┴───────────┴────────────┴────────────┴───────╯

· top of the window is 0x4753…8bff at +$744.30
```

---

## What makes it work

Two things have to be true for copy trading, and **neither is served by an
existing endpoint.** Both were established against the live Hideki indexer:

1. **You cannot read another account's position.** `exchange.fetchPositions()`
   only answers for the signer — so a bot whose entire job is watching somebody
   else has no SDK path to the thing it follows.
2. **The PnL tables are empty for perps.** `AccountMarketPnl` and
   `AccountMarketVolume` are prediction-market tables (`yesQuantity`, `noCost`)
   and return **zero rows** for every perp pool. There is no leaderboard to read.

dreamCopy derives both from the one perp-complete source there is — the `Fill`
table — reconstructing every account's position, average entry and realised /
unrealised PnL by replaying fills through average-cost accounting.

> A detail that silently breaks naive implementations: on perp fills
> `takerSide` and `makerSide` are **NULL** (they only carry `BUY_YES`/`SELL_YES`
> on prediction markets). `takerIsBid` is the only populated side signal, and the
> maker is by definition on the other side of it.

## Mirroring a position, not an order feed

Each cycle the bot recomputes where it should be, compares that to where it is,
and sends only the difference:

```
target = leader Δ × ratio, capped by notional
gap    = target − yours
send   = gap, when it clears the market minimum
```

That single decision makes it **self-correcting**: a missed poll, a partial fill,
a rejected order or a full restart all converge on the next cycle. An
implementation that replays the leader's individual orders drifts permanently the
first time one fails — and never notices.

## Risk controls

Copying a stranger is the premise, so the limits are not optional extras:
a **notional cap** that bounds position *value* rather than contract count;
**forward-only following** by default, so the bot never buys into a move it
already missed; **pool-authoritative sizing** through `getMaxPerpOrderSize`;
a **deadband** so dust adjustments do not pay the spread every cycle; the market
minimum respected rather than rounded into a rejected order; **config validated
at startup** rather than at the first order; and **self-following refused**,
because copying your own account compounds it every cycle. `DRY_RUN` defaults to
**true**.

**Restarts do not flatten your position.** A copy trader that forgets how much
the leader has moved computes a target of zero and sells everything it holds.
dreamCopy persists the leader's movement and the position it started from, so a
restart resumes exactly where it stopped — verified end to end.

---

## Where things are

| Path | What it is |
| --- | --- |
| [`strategies/perp-copytrader/`](strategies/perp-copytrader/) | **dreamCopy** — the bot. Start here. |
| [`strategies/perp-copytrader/README.md`](strategies/perp-copytrader/README.md) | Full docs: config, risk controls, honest limits. |
| `strategies/perp-copytrader/src/copy.ts` | Position & PnL reconstruction, and the fill-ingest fold. |
| `strategies/perp-copytrader/src/state.ts` | Restart safety: the persisted follow state. |
| `strategies/perp-copytrader/src/indexer.ts` | Indexer client and the verified schema notes. |
| [`BOT_KIT.md`](BOT_KIT.md) | The upstream bot kit's own README. |

```bash
npm test -w perp-copytrader        # 31 passing
npm run typecheck -w perp-copytrader
```

Requires Node 20+.

---

## Credit

Built on the [DreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit)
(MIT), which provides the `packages/` and the other `strategies/`. dreamCopy is
`strategies/perp-copytrader/`. The kit's original README is preserved as
[`BOT_KIT.md`](BOT_KIT.md), and its MIT licence is retained in
[`LICENSE`](LICENSE).

<div align="center">
<sub>Built for the Somnia Perps Builder Bounty.</sub>
</div>
