// dreamCopy service: the keeper and the dashboard in one process.
//
// One process is the right shape here. The keeper is the only writer to the
// follow registry and the API is the only reader that matters, so keeping them
// together removes a database, a queue and a class of races, and costs nothing
// until there are far more followers than a testnet will ever have.
//
//   npm run dev -w dreamcopy        # dry run, nothing is sent
//   DRY_RUN=false npm start -w dreamcopy

import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createExchange,
  envBool,
  envNum,
  loadEnv,
  makeChain,
  onStop,
  requireMarket,
  shutdown,
} from "@dreamdex-bot-kit/perp-core";
import { HIDEKI_INDEXER } from "@dreamdex-bot-kit/copy-core";
import { Keeper } from "./engine.js";
import { createDreamCopyServer } from "./server.js";
import { FollowStore } from "./store.js";

loadEnv();

const PORT = Math.trunc(envNum("PORT", 8787));
const INTERVAL_MS = envNum("DREAMCOPY_INTERVAL_MS", 15_000);
const STORE_PATH = process.env.DREAMCOPY_STORE ?? ".state/dreamcopy.json";
const SLIPPAGE_BPS = envNum("COPY_SLIPPAGE_BPS", 20);
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

async function main(): Promise<void> {
  // The service key signs for followers but holds nothing itself, so it is
  // loaded without `withSigner`: every write goes through a per-owner grant.
  const ctx = createExchange({ withSigner: false });
  const stopped = onStop();
  const dryRun = ctx.config.dryRun;
  const indexerUrl = process.env.INDEXER_URL ?? ctx.config.indexerUrl ?? HIDEKI_INDEXER;
  const store = new FollowStore(STORE_PATH);

  if (ctx.config.owner) {
    console.log(
      "note: OWNER_ADDRESS is set, which this service ignores. Followers are enrolled through the dashboard, " +
        "each granting the service key on their own account.",
    );
  }

  const keeper = new Keeper({
    store,
    exchange: ctx.exchange,
    config: ctx.config,
    chain: makeChain(ctx.config),
    privateKey: ctx.config.privateKey,
    indexerUrl,
    dryRun,
    slippageBps: SLIPPAGE_BPS,
    onLog: (line) => console.log(`[keeper] ${line}`),
  });

  /** Accept `BTC`, `BTC-PERP`, or the SDK symbol itself. */
  async function resolveMarket(query: string) {
    const wanted = /-perp$/i.test(query) || query.includes("/") ? query : `${query.toUpperCase()}-PERP`;
    try {
      const market = await requireMarket(ctx.exchange, wanted);
      return {
        symbol: market.symbol,
        name: market.display,
        pool: market.info.poolAddress,
        baseDecimals: market.info.baseDecimals,
      };
    } catch {
      return undefined;
    }
  }

  async function positionOf(symbol: string, owner: string): Promise<bigint> {
    const market = await requireMarket(ctx.exchange, symbol);
    const position = await ctx.exchange.client.getPerpPosition({
      marginBank: market.info.marginBank,
      account: owner as `0x${string}`,
      pool: market.info.poolAddress,
    });
    return position.size;
  }

  const server = createDreamCopyServer({
    store,
    keeper,
    indexerUrl,
    network: ctx.config.network,
    dryRun,
    webRoot: WEB_ROOT,
    resolveMarket,
    positionOf,
  });

  // The dashboard is meant to be looked at on a phone as well as a laptop, so
  // the LAN address is printed rather than left to be worked out.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

  server.listen(PORT, () => {
    console.log("");
    console.log(`  dreamCopy  ·  ${dryRun ? "DRY RUN — nothing is sent" : "LIVE — orders are real"}`);
    console.log(`  dashboard  http://localhost:${PORT}`);
    if (lan) console.log(`  on phone   http://${lan}:${PORT}`);
    console.log(`  network    ${ctx.config.network}`);
    console.log(
      `  bot key    ${keeper.operatorAddress ?? "none — set PRIVATE_KEY to let followers link this service"}`,
    );
    console.log(`  follows    ${store.active().length} active of ${store.list().length}`);
    console.log("");
  });

  await keeper.run(INTERVAL_MS, stopped);

  server.close();
  await shutdown(ctx);
  console.log("stopped.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nerror: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  },
);
