// dreamCopy — follow the best trader on a DreamDEX perp market, automatically.
//
// The bot mirrors a leader's POSITION rather than replaying their orders. Each
// cycle it recomputes where it should be, compares that to where it is, and
// sends the difference. That one decision makes it self-correcting: a missed
// poll, a partial fill or a restart all converge on the next cycle instead of
// drifting, which an order-replaying copier never recovers from.
//
//   target = (leader's net − baseline) × ratio, capped by notional
//   gap    = target − ours
//   send   = gap, when it clears the market's minimum
//
// Position data for the leader comes from the indexer, because the SDK only
// ever reports the signer's own positions. Our own side is read from the SDK,
// which is authoritative and immediate.
//
// DRY_RUN=true (the default) logs intended orders without sending them.
//
//   npm run scan  -w perp-copytrader -- BTC     # pick someone to follow
//   npm run start -w perp-copytrader            # follow them

import {
  ORDER_TYPE,
  createExchange,
  ensureLeverage,
  envBool,
  envNum,
  liveMark,
  loadEnv,
  markOf,
  onStop,
  placePerp,
  positionIn,
  preflight,
  requireMarket,
  shutdown,
  sizeOrder,
  sleep,
  tradingKeyCheck,
  type Side,
} from "@dreamdex-bot-kit/perp-core";

import { alignToLot, buildLeaderboard, clampToNotional, netPosition, signedQty } from "./copy.js";
import { HIDEKI_INDEXER, fetchAccountFills, fetchRecentFills, norm, type Fill } from "./indexer.js";
import { ago, bar, banner, c, field, heading, info, money, num, ok, short, signedQty as fmtQty, table, warn } from "./ui.js";

// Read .env before the constants below are evaluated: ES modules bind these at
// import time, which is earlier than anything inside main().
loadEnv();

const LEADER = (process.env.COPY_LEADER ?? "").trim();
const RATIO = envNum("COPY_RATIO", 0.1);
const MAX_NOTIONAL = envNum("COPY_MAX_NOTIONAL_USDSO", 100);
const FOLLOW_EXISTING = envBool("COPY_FOLLOW_EXISTING", false);
const POLL_MS = envNum("COPY_POLL_MS", 15_000);
const SCAN_FILLS = envNum("COPY_SCAN_FILLS", 2_000);
const MIN_VOLUME = envNum("COPY_MIN_VOLUME", 500);
const MIN_TAKER_SHARE = envNum("COPY_MIN_TAKER_SHARE", 0.1);
const LEVERAGE = envNum("PERP_LEVERAGE", 2);
const INDEXER = process.env.INDEXER_URL ?? HIDEKI_INDEXER;

/** Scale a signed raw size by a fractional ratio without leaving integer maths. */
function scaleBy(raw: bigint, ratio: number): bigint {
  const bps = BigInt(Math.max(0, Math.round(ratio * 10_000)));
  return (raw * bps) / 10_000n;
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: live });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, ctx.config.symbol || "BTC-PERP");
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;
  const pool = market.info.poolAddress;
  const scale = 10 ** market.info.baseDecimals;
  const lot = BigInt(market.info.lotSize ?? 0);
  const minQty = BigInt(market.info.minQuantity ?? 0);
  const sym = market.info.baseSymbol;

  console.log(banner(`copy trading on ${market.display}`));

  console.log(heading("Market"));
  console.log(field("market", c.text(market.display)));
  console.log(field("pool", c.faint(pool)));
  console.log(field("mode", ctx.config.dryRun ? c.amber("dry run — nothing is sent") : c.mint("LIVE — orders are real")));

  // ── who we are ───────────────────────────────────────────────────────────
  console.log(heading("Account"));
  if (!me) {
    console.log(field("account", c.dim("read-only (no PRIVATE_KEY)")));
    console.log(field("", c.faint("set one to mirror a leader; the scan command needs no key at all")));
  } else {
    console.log(field("account", c.text(me)));
    const link = await tradingKeyCheck(ctx, market);
    if (link.message) console.log(field("link", c.dim(link.message)));
    if (!link.ok && !ctx.config.dryRun) process.exit(1);

    const lev = await ensureLeverage(ctx, market, me, LEVERAGE);
    if (!lev.dryRun) {
      console.log(field("leverage", c.dim(lev.changed ? `set to ${lev.to}x` : `${lev.to ?? lev.from ?? "?"}x`)));
    }
    // The cap is position value; the margin it needs is that over the lever.
    const check = await preflight(ctx.exchange, market, me, {
      requiredUsdso: MAX_NOTIONAL / Math.max(1, LEVERAGE),
      linkedAccount: Boolean(ctx.config.owner),
    });
    console.log(field("margin", check.ok ? c.dim(check.message) : c.rose(check.message)));
    if (!check.ok) process.exit(1);
  }

  const mark0 = (await liveMark(ctx.exchange, market)) ?? markOf(market.info);

  // ── who we follow ────────────────────────────────────────────────────────
  console.log(heading("Leader"));
  let leader = norm(LEADER);
  if (leader) {
    console.log(field("chosen", `${c.text(leader)} ${c.dim("(COPY_LEADER)")}`));
  } else {
    console.log(field("choosing", c.dim(`ranking the last ${SCAN_FILLS.toLocaleString("en-US")} fills…`)));
    const window = await fetchRecentFills(INDEXER, pool, SCAN_FILLS);
    const ranked = buildLeaderboard(window, market.info.baseDecimals, mark0, {
      minVolume: MIN_VOLUME,
      minTakerShare: MIN_TAKER_SHARE,
      // Never follow ourselves: it would compound our own position every cycle.
      exclude: [me, ctx.config.owner].filter(Boolean) as string[],
    });
    const top = ranked.slice(0, 5);
    if (top.length === 0) {
      console.log(
        `\n${warn("nobody in the window clears the filters, so there is nobody to follow.")}\n` +
          `  ${c.dim("Lower COPY_MIN_VOLUME, widen COPY_SCAN_FILLS, or name one with COPY_LEADER.")}\n`,
      );
      await shutdown(ctx);
      return;
    }
    const peak = Math.max(...top.map((r) => Math.abs(r.total)), 1);
    console.log(
      `\n${table(
        [
          { header: "#", align: "right" },
          { header: "TRADER" },
          { header: "POSITION", align: "right" },
          { header: "TOTAL PNL", align: "right" },
          { header: "" },
          { header: "VOLUME", align: "right" },
          { header: "TAKER", align: "right" },
          { header: "LAST", align: "right" },
        ],
        top.map((r, i) => [
          c.dim(String(i + 1)),
          i === 0 ? c.bold(c.text(short(r.account))) : c.text(short(r.account)),
          fmtQty(r.netHuman, sym, 4),
          c.bold(money(r.total)),
          bar(r.total, peak),
          c.dim(`$${num(r.volume, 0)}`),
          c.dim(`${(r.takerShare * 100).toFixed(0)}%`),
          c.faint(ago(r.lastTimestamp)),
        ]),
      )}`,
    );
    leader = top[0]!.account;
    console.log(`\n${ok(`following ${c.bold(c.text(short(leader)))}`)}`);
  }

  if (me && leader === norm(me)) {
    console.log(`\n${warn("the leader is this account. Copying yourself compounds your own position.")}\n`);
    await shutdown(ctx);
    return;
  }

  // ── the policy ───────────────────────────────────────────────────────────
  // Two ways to follow, which cost very different amounts to start.
  //
  // By default the bot copies what the leader does NEXT: it starts counting at
  // zero from now, so the work is proportional to their new fills and no
  // history is read at all. It also will not buy into a move it already missed,
  // which is the safer default for somebody else's entry.
  //
  // COPY_FOLLOW_EXISTING=true mirrors their whole position instead, and that
  // needs their entire history to know what it is. On a high-frequency account
  // that is a great many rows, so the read is capped and says when it hit it.
  let leaderNet = 0n;
  let since = Math.floor(Date.now() / 1000);
  // Ids already counted at exactly `since`. The indexer filter is `>=`, so the
  // boundary second comes back every poll; without this its fills count twice
  // and the target is permanently wrong.
  let boundary = new Set<string>();

  if (FOLLOW_EXISTING) {
    const cap = Math.trunc(envNum("COPY_HISTORY_CAP", 50_000));
    const history = await fetchAccountFills(INDEXER, pool, leader, { cap });
    leaderNet = netPosition(history, leader);
    const newest = history.reduce((t, f) => Math.max(t, f.timestamp), 0);
    if (newest > 0) {
      since = newest;
      boundary = new Set(history.filter((f) => f.timestamp === newest).map((f) => f.id));
    }
    if (history.length >= cap) {
      console.log(
        `\n${warn(
          `stopped at the ${cap.toLocaleString("en-US")}-fill cap, so this position may be incomplete. ` +
            `Raise COPY_HISTORY_CAP, or leave COPY_FOLLOW_EXISTING off.`,
        )}`,
      );
    }
  }

  console.log(heading("Copy policy"));
  console.log(field("ratio", `${c.text(`${(RATIO * 100).toFixed(1)}%`)} ${c.dim("of the leader's size")}`));
  console.log(field("cap", `${c.text(`$${num(MAX_NOTIONAL, 0)}`)} ${c.dim("max position value")}`));
  console.log(
    field(
      "copying",
      FOLLOW_EXISTING
        ? `${c.text("their whole position")} ${c.dim(`— currently ${fmtQty(Number(leaderNet) / scale, sym, 5)}`)}`
        : `${c.text("their moves from now on")} ${c.dim("— not the position they already hold")}`,
    ),
  );
  console.log(field("poll", c.dim(`${(POLL_MS / 1000).toFixed(0)}s`)));

  console.log(heading("Following"));
  if (!me) {
    console.log(`  ${c.dim("read-only: the target is shown each cycle, nothing is sent.")}`);
  }

  // ── the loop ─────────────────────────────────────────────────────────────
  while (!stopped()) {
    try {
      // Re-read the market: `market.info` is a snapshot, so a loop that reuses
      // it watches the mark it started with forever.
      const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
      const mark = (await liveMark(ctx.exchange, fresh)) ?? markOf(fresh.info);

      // Incremental: only the boundary second is ever re-read, and the ids
      // already counted in it are skipped. Nothing older is fetched again.
      const recent = await fetchAccountFills(INDEXER, pool, leader, { sinceTimestamp: since, cap: 20_000 });
      const added: Fill[] = [];
      let newest = since;
      for (const f of recent) {
        if (f.timestamp < since) continue;
        if (f.timestamp === since && boundary.has(f.id)) continue;
        added.push(f);
        leaderNet += signedQty(f, leader);
        if (f.timestamp > newest) newest = f.timestamp;
      }
      if (newest > since) {
        since = newest;
        boundary = new Set(added.filter((f) => f.timestamp === newest).map((f) => f.id));
      } else {
        for (const f of added) boundary.add(f.id);
      }

      const target = alignToLot(
        clampToNotional(scaleBy(leaderNet, RATIO), mark, MAX_NOTIONAL, fresh.info.baseDecimals),
        lot,
      );

      const position = me ? await positionIn(ctx.exchange, fresh) : undefined;
      const ours = position
        ? BigInt(Math.round(position.contracts * scale)) * (position.side === "short" ? -1n : 1n)
        : 0n;
      const gap = alignToLot(target - ours, lot);
      const stamp = c.faint(new Date().toTimeString().slice(0, 8));

      const line =
        `${stamp} ${c.dim(FOLLOW_EXISTING ? "leader" : "leader Δ")} ${fmtQty(Number(leaderNet) / scale, sym, 5)}` +
        `  ${c.dim("target")} ${fmtQty(Number(target) / scale, sym, 5)}` +
        `  ${c.dim("ours")} ${fmtQty(Number(ours) / scale, sym, 5)}` +
        (added.length > 0 ? `  ${c.violet(`${added.length} new fill(s)`)}` : "");

      const magnitude = gap < 0n ? -gap : gap;
      if (magnitude < minQty || magnitude === 0n) {
        console.log(`${line}  ${c.faint("· in line")}`);
      } else if (!me) {
        console.log(`${line}  ${c.amber(`· would move ${num(Number(gap) / scale, 5)} ${sym}`)}`);
      } else {
        const side: Side = gap > 0n ? "long" : "short";
        console.log(`${line}  ${c.sky(`· mirroring ${side} ${num(Number(magnitude) / scale, 5)} ${sym}`)}`);

        const book = await ctx.exchange.fetchOrderBook(fresh.symbol, 1);
        const touch = side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
        if (touch === undefined) {
          console.log(`  ${warn("no counterparty resting on the book, waiting")}`);
        } else {
          const price = BigInt(Math.round(touch * 1e18));
          const sized = await sizeOrder(ctx.exchange, {
            market: fresh,
            account: me,
            side,
            price,
            wanted: magnitude,
            autoPull: true,
            tradingKey: ctx.tradingKey,
          });
          if (!sized.ok) {
            console.log(`  ${warn(`cannot mirror: ${sized.reason}`)}`);
          } else {
            if (sized.quantity < magnitude) {
              console.log(`  ${c.dim(`capped to ${num(Number(sized.quantity) / scale, 5)} ${sym} by ${sized.limitedBy ?? "the pool"}`)}`);
            }
            await placePerp({
              ctx,
              market: fresh,
              side,
              price,
              quantity: sized.quantity,
              orderType: ORDER_TYPE.MARKET,
              label: "mirror",
            });
          }
        }
      }
    } catch (err) {
      // A bad cycle is not a reason to abandon the position. The next one
      // recomputes the target from scratch, so a transient failure costs a tick.
      console.log(`  ${warn((err as Error).message.slice(0, 160))}`);
    }

    await sleep(POLL_MS, stopped);
  }

  console.log(`\n${info("stopped. The position stays as it is; restart to resume following.")}\n`);
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n${c.rose("error: ")}${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  },
);
