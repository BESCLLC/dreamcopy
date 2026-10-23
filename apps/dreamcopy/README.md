<div align="center">

# dreamCopy — the service

**Hosted copy trading for DreamDEX perps. Non-custodial.**

Leaderboard · follow in one signature · mirrored automatically

</div>

---

The CLI in [`strategies/perp-copytrader`](../../strategies/perp-copytrader) follows
one trader from one wallet. This is the product: a leaderboard anyone can read,
a dashboard anyone can follow from, and one keeper mirroring many leaders onto
many accounts.

```bash
npm install
npm run dev -w dreamcopy      # dry run — nothing is sent
open http://localhost:8787
```

---

## Why this can exist at all

A hosted copy trader normally means giving somebody your funds. On DreamDEX it
does not, because of a primitive most people have not noticed.

The operator registry grants permission per **`(owner, operator, selector)`**.
So *many* accounts can authorise the *same* bot key, and that key can then call
`placeOrderFor(owner, …)` on each of their behalf:

- margin comes from **each follower's own MarginBank**
- every fill settles to **them**
- the grant covers `placeOrderFor` / `cancelOrderFor` / `reduceOrderFor` — and
  **nothing else**, so the key **cannot withdraw**

One service key, many followers, no custody. Followers grant it in the app under
*wallet → Link a bot → Perps*, and revoke it there whenever they like.

---

## How a follow works

```
  leaderboard  ──►  Follow  ──►  sign (wallet)  ──►  keeper mirrors it
       │                                                    │
  Fill replay                                      placeOrderFor(owner,…)
  (indexer)                                        margin: follower's own
```

1. **Rank.** Every trader on the market is reconstructed from indexer fills —
   position, average entry, realised and unrealised PnL. (The venue's PnL tables
   are prediction-market tables and are empty for perps, so this is computed,
   not read. See [`packages/copy-core`](../../packages/copy-core).)
2. **Follow.** The follower picks a ratio and a cap and signs. The signature
   covers the exact terms, so the API never takes an owner address on trust.
3. **Mirror.** Each cycle the keeper recomputes where that follower *should* be,
   compares it to where they *are*, and sends the difference.

Work is shared where it is identical and separate where it is not: one market
read serves every follow on that market, and one indexer read serves every
follower of the same leader — but each follow keeps its **own cursor and own
anchor**, because two people who started following the same trader at different
moments do not have the same target.

---

## Safety

- **Non-custodial** — the key places, cancels and reduces. It cannot withdraw.
- **Signed enrolment** — following and unfollowing are signed by the owner, over
  the exact market and leader, and expire after ten minutes. A forged signature,
  a swapped leader and a replayed request are all rejected.
- **Per-follower cap** — `maxNotional` bounds position *value*, not contract
  count. A leader at 50× leverage cannot drag a follower past their own cap.
- **Anchored** — enrolling records what the follower already holds, so the
  service never sells a position it did not open.
- **Pool-authoritative sizing** — every order goes through `getMaxPerpOrderSize`
  against the follower's own margin, so the venue's rule decides the size.
- **Self-follow refused** — copying your own account compounds it every cycle.
- **Isolated failures** — one follower's bad cycle is one row's problem; it
  never stops the others, and the cursor does not advance past work not done.
- **`DRY_RUN` defaults to true.**

---

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PRIVATE_KEY` | — | The service bot key followers link. Place/cancel/reduce only. |
| `DRY_RUN` | `true` | `false` sends real orders. |
| `NETWORK` | `hideki` | Somnia network. |
| `PORT` | `8787` | Dashboard and API. |
| `DREAMCOPY_INTERVAL_MS` | `15000` | Keeper cycle. |
| `DREAMCOPY_STORE` | `.state/dreamcopy.json` | The follow registry. |
| `COPY_SLIPPAGE_BPS` | `20` | How far past the touch a mirroring taker may pay. |

The service ignores `OWNER_ADDRESS`: followers are enrolled through the
dashboard, each granting the key on their own account.

---

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/status` | network, mode, bot-key address, last cycle |
| `GET` | `/api/markets` | every perp market, busiest first |
| `GET` | `/api/leaderboard?market=ETH-PERP` | ranked traders for a market |
| `GET` | `/api/follows?owner=0x…` | that account's follows and their state |
| `POST` | `/api/follows` | start following — **signed** |
| `POST` | `/api/follows/stop` | stop — **signed** |

The signed body is `{ owner, market, leader, issued, signature }` over:

```
dreamCopy
action: follow
owner: 0x…
market: ETH-PERP
leader: 0x…
issued: 2026-10-23T19:00:00.000Z
```

---

## The dashboard

Dark, dense and readable at a glance: mint and rose are the only colours that
carry meaning (long/short, profit/loss), everything else is structure. On a
phone each leaderboard row becomes a card — identity and PnL lead, the rest
reads as labelled pairs, Follow becomes a full-width target — from the same DOM,
so there is one leaderboard rather than two that can disagree.

With no service behind it the page falls back to a snapshot of real Hideki data
and labels itself **demo data**, so it is never an empty table. Nothing is sent
in that mode.

```bash
npm run typecheck -w dreamcopy
npm test -w dreamcopy
```

<div align="center">
<sub>Built on the DreamDEX bot kit for the Somnia Perps Builder Bounty.</sub>
</div>
