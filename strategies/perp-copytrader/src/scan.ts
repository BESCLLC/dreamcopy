// `scan` — who is worth following on a market, and why.
//
// Deliberately indexer-only: no private key, no funding, no chain access, no
// SDK. It answers the question the copy trader has to answer before it can do
// anything, and it answers it for anyone who runs it, which makes it the
// honest way to inspect what the bot is about to act on.
//
//   npm run scan -w perp-copytrader             # list perp markets
//   npm run scan -w perp-copytrader -- DOGE     # leaderboard for a market
//   npm run scan -w perp-copytrader -- 0x…      # ...or by pool address

import { buildLeaderboard } from "@dreamdex-bot-kit/copy-core";
import {
  HIDEKI_INDEXER,
  IndexerError,
  fetchMarketFacts,
  fetchPerpMarkets,
  fetchRecentFills,
  type MarketFacts,
} from "@dreamdex-bot-kit/copy-core";
import { ago, bar, banner, c, clip, field, heading, info, money, num, short, signedQty, table, warn } from "./ui.js";

const INDEXER = process.env.INDEXER_URL ?? HIDEKI_INDEXER;
const WINDOW = Number(process.env.COPY_SCAN_FILLS ?? 2_000);
const MIN_VOLUME = Number(process.env.COPY_MIN_VOLUME ?? 500);
const MIN_TAKER_SHARE = Number(process.env.COPY_MIN_TAKER_SHARE ?? 0.1);
const TOP = Number(process.env.COPY_SCAN_TOP ?? 12);

/** Accept a pool address or a base symbol, because nobody remembers pool addresses. */
async function resolveMarket(query: string): Promise<MarketFacts | undefined> {
  if (/^0x[0-9a-fA-F]{40}$/.test(query)) return fetchMarketFacts(INDEXER, query);
  const markets = await fetchPerpMarkets(INDEXER, 100);
  return markets.find((m) => m.baseSymbol.toLowerCase() === query.toLowerCase());
}

async function listMarkets(): Promise<void> {
  const markets = await fetchPerpMarkets(INDEXER, 25);
  console.log(heading(`Perp markets  ${c.dim(`(${markets.length}, busiest first)`)}`));
  console.log(
    table(
      [
        { header: "MARKET" },
        { header: "MARK", align: "right" },
        { header: "TRADES", align: "right" },
        { header: "POOL" },
      ],
      markets.map((m) => [
        c.text(`${m.baseSymbol}-PERP`),
        Number.isFinite(m.markPrice) ? c.text(num(m.markPrice, m.markPrice < 1 ? 5 : 2)) : c.dim("—"),
        c.dim(m.tradeCount.toLocaleString("en-US")),
        c.faint(m.poolAddress),
      ]),
    ),
  );
  console.log(`\n  ${c.dim("Leaderboard for one:")} ${c.sky("npm run scan -w perp-copytrader -- DOGE")}\n`);
}

async function leaderboard(query: string): Promise<void> {
  const market = await resolveMarket(query);
  if (!market) {
    console.log(warn(`no perp market matches ${c.bold(query)}. Run without arguments to list them.`));
    process.exitCode = 1;
    return;
  }

  console.log(heading(`${market.baseSymbol}-PERP`));
  console.log(field("mark", Number.isFinite(market.markPrice) ? c.text(num(market.markPrice, market.markPrice < 1 ? 5 : 2)) : c.dim("un-priceable")));
  console.log(field("pool", c.faint(market.poolAddress)));
  console.log(field("window", c.dim(`last ${WINDOW.toLocaleString("en-US")} fills`)));

  const fills = await fetchRecentFills(INDEXER, market.poolAddress, WINDOW);
  if (fills.length === 0) {
    console.log(`\n${warn("no fills on this market yet, so there is nobody to rank.")}\n`);
    return;
  }

  const ranked = buildLeaderboard(fills, market.baseDecimals, market.markPrice, {
    minVolume: MIN_VOLUME,
    minTakerShare: MIN_TAKER_SHARE,
  });

  const oldest = fills[0];
  const newest = fills[fills.length - 1];
  const span = oldest && newest ? `${ago(oldest.timestamp)} → ${ago(newest.timestamp)}` : "";
  console.log(field("covering", c.dim(`${fills.length.toLocaleString("en-US")} fills, ${span}`)));

  // A price-appropriate size column: BTC moves in thousandths, DOGE in thousands.
  const px = market.markPrice;
  const qtyDp = !Number.isFinite(px) ? 3 : px >= 10_000 ? 5 : px >= 1_000 ? 4 : px >= 10 ? 3 : px >= 1 ? 2 : 1;

  if (ranked.length === 0) {
    console.log(
      `\n${warn(
        `every account in the window is below the filters ` +
          `(volume ≥ $${num(MIN_VOLUME, 0)}, taker share ≥ ${(MIN_TAKER_SHARE * 100).toFixed(0)}%). ` +
          `Lower COPY_MIN_VOLUME to see them.`,
      )}\n`,
    );
    return;
  }

  const top = ranked.slice(0, TOP);
  const peak = Math.max(...top.map((r) => Math.abs(r.total)), 1);

  console.log(
    `\n${table(
      [
        { header: "#", align: "right" },
        { header: "TRADER" },
        { header: "POSITION", align: "right" },
        { header: "ENTRY", align: "right" },
        { header: "REALIZED", align: "right" },
        { header: "UNREAL.", align: "right" },
        { header: "TOTAL PNL", align: "right" },
        { header: "" },
        { header: "VOLUME", align: "right" },
        { header: "TAKER", align: "right" },
        { header: "LAST", align: "right" },
      ],
      top.map((r, i) => [
        c.dim(String(i + 1)),
        c.text(short(r.account)),
        signedQty(r.netHuman, market.baseSymbol, qtyDp),
        r.avgEntry > 0 ? c.dim(num(r.avgEntry, r.avgEntry < 1 ? 5 : 2)) : c.faint("—"),
        money(r.realized),
        money(r.unrealized),
        c.bold(money(r.total)),
        bar(r.total, peak),
        c.dim(`$${num(r.volume, 0)}`),
        c.dim(`${(r.takerShare * 100).toFixed(0)}%`),
        c.faint(ago(r.lastTimestamp)),
      ]),
    )}`,
  );

  const best = top[0];
  if (best) {
    console.log(`\n${info(`top of the window is ${c.bold(c.text(short(best.account)))} at ${money(best.total)}`)}`);
    console.log(`  ${c.dim("follow it:")} ${c.sky(`COPY_LEADER=${best.account} npm run start -w perp-copytrader`)}\n`);
  }

  console.log(
    `  ${c.faint(
      "PnL is windowed: accounting starts at the first fill in the window, so a position opened before it",
    )}\n  ${c.faint("counts from its first in-window fill. Widen with COPY_SCAN_FILLS.")}\n`,
  );
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).find((a) => !a.startsWith("-"));
  console.log(banner(query ? "leaderboard" : "perp markets on Somnia"));
  if (query) await leaderboard(query);
  else await listMarkets();
}

main().catch((err) => {
  console.error(
    `\n${err instanceof IndexerError ? c.rose("indexer: ") : c.rose("error: ")}${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
