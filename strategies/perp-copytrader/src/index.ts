// dreamCopy — follow the best trader on a DreamDEX perp market, automatically.
//
// The bot mirrors a leader's POSITION rather than replaying their orders. Each
// cycle it recomputes where it should be, compares that to where it is, and
// sends the difference. That one decision makes it self-correcting: a missed
// poll, a partial fill or a restart all converge on the next cycle instead of
// drifting, which an order-replaying copier never recovers from.
//
//   target = anchor + (leader's movement × ratio), capped by notional
//   gap    = target − ours
//   send   = gap, when it clears the market minimum and the deadband
//
// `anchor` is our position when following began. It is why a restart does not
// flatten an inherited position: without it the leader's movement would be
// counted from zero, the target would be zero, and the bot would close a
// position it never opened. It is persisted with the rest of the follow state.
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
  type PerpContext,
  type Side,
} from "@dreamdex-bot-kit/perp-core";
import { isAddress, parseUnits } from "viem";

import {
  alignToLot,
  buildLeaderboard,
  clampToNotional,
  ingest,
  netPosition,
  type FollowState,
} from "./copy.js";
import { HIDEKI_INDEXER, fetchAccountFills, fetchRecentFills, norm } from "./indexer.js";
import { loadState, saveState, type StateKey } from "./state.js";
import { ago, bad, bar, banner, c, field, heading, info, money, num, ok, short, signedQty as fmtQty, table, warn } from "./ui.js";

// Read .env before the constants below are evaluated: ES modules bind these at
// import time, which is earlier than anything inside main().
loadEnv();

const LEADER = (process.env.COPY_LEADER ?? "").trim();
const RATIO = envNum("COPY_RATIO", 0.1);
const MAX_NOTIONAL = envNum("COPY_MAX_NOTIONAL_USDSO", 100);
const MIN_GAP = envNum("COPY_MIN_GAP_USDSO", 1);
const FOLLOW_EXISTING = envBool("COPY_FOLLOW_EXISTING", false);
const POLL_MS = envNum("COPY_POLL_MS", 15_000);
const SCAN_FILLS = envNum("COPY_SCAN_FILLS", 2_000);
const MIN_VOLUME = envNum("COPY_MIN_VOLUME", 500);
const MIN_TAKER_SHARE = envNum("COPY_MIN_TAKER_SHARE", 0.1);
const LEVERAGE = envNum("PERP_LEVERAGE", 2);
const MAX_FAILURES = envNum("COPY_MAX_FAILURES", 10);
// How far past the touch a mirroring taker may pay. A copy that will not cross
// is a copy that does not happen, and the leader has already moved.
const SLIPPAGE_BPS = envNum("COPY_SLIPPAGE_BPS", 20);
const STATE_ENABLED = envBool("COPY_STATE", true);
const STATE_DIR = process.env.COPY_STATE_DIR ?? ".state";
const INDEXER = process.env.INDEXER_URL ?? HIDEKI_INDEXER;

/** Scale a signed raw size by a fractional ratio without leaving integer maths. */
function scaleBy(raw: bigint, ratio: number): bigint {
  const bps = BigInt(Math.max(0, Math.round(ratio * 10_000)));
  return (raw * bps) / 10_000n;
}

/**
 * Stop before trading on a setting that cannot be meant.
 *
 * Every one of these would otherwise fail somewhere less obvious: a zero ratio
 * silently never trades, a one-second poll hammers the indexer until it refuses,
 * and a ratio of 50 reads as "50%" to everyone who has ever typed a percentage.
 */
function validate(): void {
  const problems: string[] = [];
  if (!(RATIO > 0)) problems.push("COPY_RATIO must be greater than 0 (0.1 mirrors a tenth of the leader's size).");
  if (RATIO > 10) problems.push(`COPY_RATIO=${RATIO} is a multiple, not a percent: 0.1 is 10%. Use a value at or below 10.`);
  if (!(MAX_NOTIONAL > 0)) problems.push("COPY_MAX_NOTIONAL_USDSO must be greater than 0; it is the cap on position value.");
  if (MIN_GAP < 0) problems.push("COPY_MIN_GAP_USDSO cannot be negative.");
  if (POLL_MS < 2_000) problems.push(`COPY_POLL_MS=${POLL_MS} is too aggressive; use 2000 or more.`);
  if (!(SCAN_FILLS > 0)) problems.push("COPY_SCAN_FILLS must be greater than 0.");
  if (MIN_TAKER_SHARE < 0 || MIN_TAKER_SHARE > 1) problems.push("COPY_MIN_TAKER_SHARE is a fraction between 0 and 1.");
  if (LEVERAGE < 1) problems.push("PERP_LEVERAGE must be at least 1.");
  if (MAX_FAILURES < 1) problems.push("COPY_MAX_FAILURES must be at least 1.");
  if (SLIPPAGE_BPS < 0 || SLIPPAGE_BPS > 1_000) {
    problems.push("COPY_SLIPPAGE_BPS is in basis points and must be between 0 and 1000 (1000 = 10%).");
  }
  if (LEADER && !isAddress(LEADER)) problems.push(`COPY_LEADER="${LEADER}" is not an address.`);
  if (problems.length > 0) {
    console.error(`\n${c.rose("config:")}`);
    for (const p of problems) console.error(`  ${bad(p)}`);
    console.error("");
    process.exit(1);
  }
}

/**
 * Our position in raw base units, signed.
 *
 * `UnifiedPosition.contracts` is a float in human units and the SDK exposes no
 * raw form, so it has to be converted. Multiplying by 10**decimals loses the
 * low digits the moment the product passes 2**53, which an 18-decimal market
 * does at nine units. Formatting to a fixed-point string and parsing that keeps
 * every digit the float actually carries.
 */
async function positionRaw(ctx: PerpContext, market: Awaited<ReturnType<typeof requireMarket>>): Promise<bigint> {
  const position = await positionIn(ctx.exchange, market);
  if (!position || !Number.isFinite(position.contracts)) return 0n;
  const decimals = market.info.baseDecimals;
  const raw = parseUnits(Math.abs(position.contracts).toFixed(decimals), decimals);
  return position.side === "short" ? -raw : raw;
}

async function main(): Promise<void> {
  validate();
  const liveTrading = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: liveTrading });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, ctx.config.symbol || "BTC-PERP");
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;
  const pool = market.info.poolAddress;
  const decimals = market.info.baseDecimals;
  const scale = 10 ** decimals;
  const lot = BigInt(market.info.lotSize ?? 0);
  const minQty = BigInt(market.info.minQuantity ?? 0);
  const sym = market.info.baseSymbol;
  const human = (raw: bigint) => Number(raw) / scale;

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
    const ranked = buildLeaderboard(window, decimals, mark0, {
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
  if (ctx.config.owner && leader === norm(ctx.config.owner)) {
    console.log(`\n${warn("the leader is the account this key trades for. Copying it compounds its own position.")}\n`);
    await shutdown(ctx);
    return;
  }

  // ── where we are following from ──────────────────────────────────────────
  const key: StateKey = {
    network: ctx.config.network,
    symbol: market.symbol,
    leader,
    followExisting: FOLLOW_EXISTING,
  };
  const restored = STATE_ENABLED ? loadState(STATE_DIR, key) : undefined;

  let follow: FollowState;
  let anchor: bigint;

  if (restored) {
    // Resuming: both the count and the position it was measured from come back,
    // so the target lands exactly where it was before the restart.
    follow = restored.state;
    anchor = restored.anchor;
  } else if (FOLLOW_EXISTING) {
    const cap = Math.trunc(envNum("COPY_HISTORY_CAP", 50_000));
    const history = await fetchAccountFills(INDEXER, pool, leader, { cap });
    const newest = history.reduce((t, f) => Math.max(t, f.timestamp), 0);
    follow = {
      leaderNet: netPosition(history, leader),
      since: newest > 0 ? newest : Math.floor(Date.now() / 1000),
      boundary: new Set(history.filter((f) => f.timestamp === newest).map((f) => f.id)),
    };
    anchor = 0n;
    if (history.length >= cap) {
      console.log(
        `\n${warn(
          `stopped at the ${cap.toLocaleString("en-US")}-fill cap, so this position may be incomplete. ` +
            `Raise COPY_HISTORY_CAP, or leave COPY_FOLLOW_EXISTING off.`,
        )}`,
      );
    }
  } else {
    // Following forward. Anchoring on whatever we already hold is what stops a
    // fresh start from reading an inherited position as "too long" and selling it.
    follow = { leaderNet: 0n, since: Math.floor(Date.now() / 1000), boundary: new Set() };
    anchor = me ? await positionRaw(ctx, market) : 0n;
  }

  console.log(heading("Copy policy"));
  console.log(field("ratio", `${c.text(`${(RATIO * 100).toFixed(1)}%`)} ${c.dim("of the leader's size")}`));
  console.log(field("cap", `${c.text(`$${num(MAX_NOTIONAL, 0)}`)} ${c.dim("max position value")}`));
  console.log(field("deadband", c.dim(MIN_GAP > 0 ? `ignore adjustments under $${num(MIN_GAP, 2)}` : "none")));
  console.log(
    field(
      "copying",
      FOLLOW_EXISTING
        ? `${c.text("their whole position")} ${c.dim(`— currently ${fmtQty(human(follow.leaderNet), sym, 5)}`)}`
        : `${c.text("their moves from now on")} ${c.dim("— not the position they already hold")}`,
    ),
  );
  if (anchor !== 0n) {
    console.log(field("anchor", `${fmtQty(human(anchor), sym, 5)} ${c.dim("— held at start, kept as the base")}`));
  }
  if (restored) {
    console.log(field("resumed", c.mint(`from saved state (${ago(Math.floor(Date.parse(restored.updatedAt) / 1000))})`)));
  } else if (STATE_ENABLED) {
    console.log(field("state", c.dim(`${STATE_DIR}/ — restored on restart`)));
  }
  console.log(field("poll", c.dim(`${(POLL_MS / 1000).toFixed(0)}s`)));

  console.log(heading("Following"));
  if (!me) console.log(`  ${c.dim("read-only: the target is shown each cycle, nothing is sent.")}`);

  // ── the loop ─────────────────────────────────────────────────────────────
  let failures = 0;
  while (!stopped()) {
    try {
      // Re-read the market: `market.info` is a snapshot, so a loop that reuses
      // it watches the mark it started with forever.
      const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
      const mark = (await liveMark(ctx.exchange, fresh)) ?? markOf(fresh.info);

      const page = await fetchAccountFills(INDEXER, pool, leader, { sinceTimestamp: follow.since, cap: 20_000 });
      const folded = ingest(follow, page, leader);
      follow = folded.state;

      const target = alignToLot(
        clampToNotional(anchor + scaleBy(follow.leaderNet, RATIO), mark, MAX_NOTIONAL, decimals),
        lot,
      );
      const ours = me ? await positionRaw(ctx, fresh) : 0n;
      const gap = alignToLot(target - ours, lot);
      const magnitude = gap < 0n ? -gap : gap;
      const gapValue = Number.isFinite(mark) ? human(magnitude) * mark : 0;

      const stamp = c.faint(new Date().toTimeString().slice(0, 8));
      const line =
        `${stamp} ${c.dim(FOLLOW_EXISTING ? "leader" : "leader Δ")} ${fmtQty(human(follow.leaderNet), sym, 5)}` +
        `  ${c.dim("target")} ${fmtQty(human(target), sym, 5)}` +
        `  ${c.dim("ours")} ${fmtQty(human(ours), sym, 5)}` +
        (folded.added.length > 0 ? `  ${c.violet(`${folded.added.length} new fill(s)`)}` : "");

      if (magnitude === 0n || magnitude < minQty) {
        console.log(`${line}  ${c.faint("· in line")}`);
      } else if (gapValue < MIN_GAP) {
        // Crossing the spread for a few cents of alignment costs more than the
        // drift it corrects, and it repeats every cycle.
        console.log(`${line}  ${c.faint(`· within deadband ($${num(gapValue, 2)})`)}`);
      } else if (!me) {
        console.log(`${line}  ${c.amber(`· would move ${num(human(gap), 5)} ${sym}`)}`);
      } else {
        const side: Side = gap > 0n ? "long" : "short";
        console.log(`${line}  ${c.sky(`· mirroring ${side} ${num(human(magnitude), 5)} ${sym}`)}`);

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
              console.log(`  ${c.dim(`capped to ${num(human(sized.quantity), 5)} ${sym} by ${sized.limitedBy ?? "the pool"}`)}`);
            }
            await placePerp({
              ctx,
              market: fresh,
              side,
              price,
              quantity: sized.quantity,
              orderType: ORDER_TYPE.MARKET,
              slippageBps: SLIPPAGE_BPS,
              label: "mirror",
            });
          }
        }
      }

      // Persist only after a clean cycle: a state written mid-failure could
      // record fills as counted that were never acted on.
      if (STATE_ENABLED) saveState(STATE_DIR, key, follow, anchor);
      failures = 0;
    } catch (err) {
      failures += 1;
      console.log(`  ${warn(`cycle failed (${failures}/${MAX_FAILURES}): ${(err as Error).message.slice(0, 160)}`)}`);
      if (failures >= MAX_FAILURES) {
        // Exiting non-zero lets a supervisor restart the bot, which is safe
        // precisely because the follow state is on disk.
        console.log(`\n${bad(`${MAX_FAILURES} consecutive failures, stopping. The position is left as it is.`)}\n`);
        process.exitCode = 1;
        break;
      }
    }

    // Back off while failing, so an outage is not also a request flood.
    await sleep(POLL_MS * Math.min(failures + 1, 5), stopped);
  }

  if (STATE_ENABLED) saveState(STATE_DIR, key, follow, anchor);
  console.log(`\n${info("stopped. The position stays as it is; restart to resume following.")}\n`);
  await shutdown(ctx);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(`\n${c.rose("error: ")}${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  },
);
