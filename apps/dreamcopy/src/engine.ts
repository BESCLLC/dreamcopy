// The keeper: one process mirroring many leaders onto many accounts.
//
// The unlock is the operator registry. A grant is keyed on
// (owner, operator, selector), so MANY accounts can authorise the SAME bot
// key, and the key then places orders FOR each of them — margin comes from
// each follower's own MarginBank, every fill settles to them, and the key
// cannot withdraw. That is what makes a hosted copy-trading service possible
// without ever custodying anybody's funds.
//
// Work is shared where it is identical and kept separate where it is not.
// One market read serves every follow on that market; one indexer read serves
// every follower of the same leader. But each follow keeps its own cursor and
// its own anchor, because two people who started following the same trader at
// different moments do not have the same target.

import {
  ORDER_TYPE,
  createTradingKey,
  linkStatus,
  liveMark,
  markOf,
  placePerp,
  requireMarket,
  sizeOrder,
  type PerpConfig,
  type TradingKey,
} from "@dreamdex-bot-kit/perp-core";
import { fetchAccountFills, ingest, mirrorTarget } from "@dreamdex-bot-kit/copy-core";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { Chain } from "viem";
import { stateOf, type Follow, type FollowStore } from "./store.js";

export interface KeeperOptions {
  store: FollowStore;
  exchange: SomniaMarkets;
  config: PerpConfig;
  chain: Chain;
  /** The service bot key. Linked by each follower; can never withdraw. */
  privateKey?: `0x${string}`;
  indexerUrl: string;
  dryRun: boolean;
  slippageBps: number;
  onLog?: (line: string) => void;
}

export interface CycleReport {
  at: string;
  follows: number;
  acted: number;
  skipped: number;
  errors: number;
}

export class Keeper {
  private readonly keys = new Map<string, TradingKey>();
  private running = false;
  private lastReport?: CycleReport;

  constructor(private readonly o: KeeperOptions) {}

  get operatorAddress(): string | undefined {
    if (!this.o.privateKey) return undefined;
    return this.keyFor("0x0000000000000000000000000000000000000001").operator;
  }

  get report(): CycleReport | undefined {
    return this.lastReport;
  }

  private log(line: string): void {
    this.o.onLog?.(line);
  }

  /**
   * A trading key bound to one owner.
   *
   * Same private key every time, different owner: the grant that matters lives
   * on-chain per (owner, operator), so one service key serves every follower.
   */
  private keyFor(owner: string): TradingKey {
    const cached = this.keys.get(owner.toLowerCase());
    if (cached) return cached;
    if (!this.o.privateKey) throw new Error("no service key configured");
    const key = createTradingKey({
      owner: owner as `0x${string}`,
      privateKey: this.o.privateKey,
      chain: this.o.chain,
      rpcUrl: this.o.config.rpcUrl,
    });
    this.keys.set(owner.toLowerCase(), key);
    return key;
  }

  /** One pass over every active follow. Never throws: a bad follow is one row's problem. */
  async cycle(): Promise<CycleReport> {
    const follows = this.o.store.active();
    const report: CycleReport = { at: new Date().toISOString(), follows: follows.length, acted: 0, skipped: 0, errors: 0 };

    const byMarket = new Map<string, Follow[]>();
    for (const f of follows) {
      const bucket = byMarket.get(f.market);
      if (bucket) bucket.push(f);
      else byMarket.set(f.market, [f]);
    }

    for (const [symbol, marketFollows] of byMarket) {
      try {
        await this.cycleMarket(symbol, marketFollows, report);
      } catch (err) {
        report.errors += marketFollows.length;
        const message = (err as Error).message.slice(0, 200);
        this.log(`market ${symbol} failed: ${message}`);
        for (const f of marketFollows) this.o.store.saveError(f.id, message);
      }
    }

    this.lastReport = report;
    return report;
  }

  private async cycleMarket(symbol: string, follows: Follow[], report: CycleReport): Promise<void> {
    // One market read for everybody on it.
    const market = await requireMarket(this.o.exchange, symbol, { reload: true });
    const mark = (await liveMark(this.o.exchange, market)) ?? markOf(market.info);
    const pool = market.info.poolAddress;

    const byLeader = new Map<string, Follow[]>();
    for (const f of follows) {
      const bucket = byLeader.get(f.leader);
      if (bucket) bucket.push(f);
      else byLeader.set(f.leader, [f]);
    }

    for (const [leader, leaderFollows] of byLeader) {
      // One indexer read serves every follower of this leader: fetch from the
      // oldest cursor among them, and let each follow's own ingest discard
      // whatever it has already counted.
      const since = Math.min(...leaderFollows.map((f) => f.since));
      const page = await fetchAccountFills(this.o.indexerUrl, pool, leader, {
        sinceTimestamp: since,
        cap: 20_000,
      });

      for (const follow of leaderFollows) {
        try {
          await this.cycleFollow(follow, market, mark, page, report);
        } catch (err) {
          report.errors += 1;
          const message = (err as Error).message.slice(0, 200);
          this.log(`follow ${follow.id} failed: ${message}`);
          this.o.store.saveError(follow.id, message);
        }
      }
    }
  }

  private async cycleFollow(
    follow: Follow,
    market: Awaited<ReturnType<typeof requireMarket>>,
    mark: number,
    page: Awaited<ReturnType<typeof fetchAccountFills>>,
    report: CycleReport,
  ): Promise<void> {
    const owner = follow.owner as `0x${string}`;
    const folded = ingest(stateOf(follow), page, follow.leader);

    // Exact signed size from the MarginBank, for THIS follower's account.
    const position = await this.o.exchange.client.getPerpPosition({
      marginBank: market.info.marginBank,
      account: owner,
      pool: market.info.poolAddress,
    });

    const plan = mirrorTarget({
      leaderNet: folded.state.leaderNet,
      ours: position.size,
      mark,
      policy: {
        ratio: follow.ratio,
        maxNotional: follow.maxNotional,
        minGap: follow.minGap,
        anchor: BigInt(follow.anchor),
        lotSize: BigInt(market.info.lotSize ?? 0),
        minQuantity: BigInt(market.info.minQuantity ?? 0),
        baseDecimals: market.info.baseDecimals,
      },
    });

    const status = {
      lastCycleAt: new Date().toISOString(),
      target: plan.target.toString(),
      ours: position.size.toString(),
      leaderNet: folded.state.leaderNet.toString(),
      error: undefined as string | undefined,
    };

    if (!plan.act || !plan.side) {
      report.skipped += 1;
      this.o.store.saveState(follow.id, folded.state, { ...status, note: plan.reason });
      return;
    }

    // Can this key actually act for them? The pool is the authority, and a
    // follower who has not linked yet is a normal state, not a failure.
    const key = this.keyFor(owner);
    const link = await linkStatus(key, market.info.poolAddress);
    if (!link.place) {
      report.skipped += 1;
      this.o.store.saveState(follow.id, folded.state, {
        ...status,
        linked: false,
        note: "not linked — grant this service's bot key in the app (wallet → Link a bot → Perps)",
      });
      return;
    }

    const book = await this.o.exchange.fetchOrderBook(market.symbol, 1);
    const touch = plan.side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
    if (touch === undefined) {
      report.skipped += 1;
      this.o.store.saveState(follow.id, folded.state, { ...status, linked: true, note: "no counterparty on the book" });
      return;
    }

    const price = BigInt(Math.round(touch * 1e18));
    const sized = await sizeOrder(this.o.exchange, {
      market,
      account: owner,
      side: plan.side,
      price,
      wanted: plan.magnitude,
      // Only an order its owner sends can pull from the wallet; a trading key
      // never can, so the follower's MarginBank has to already hold the margin.
      autoPull: false,
      tradingKey: key,
    });
    if (!sized.ok) {
      report.skipped += 1;
      this.o.store.saveState(follow.id, folded.state, { ...status, linked: true, note: sized.reason });
      return;
    }

    await placePerp({
      ctx: { exchange: this.o.exchange, config: { dryRun: this.o.dryRun }, tradingKey: key },
      market,
      side: plan.side,
      price,
      quantity: sized.quantity,
      orderType: ORDER_TYPE.MARKET,
      slippageBps: this.o.slippageBps,
      label: `copy ${follow.leader.slice(0, 8)}→${owner.slice(0, 8)}`,
    });

    report.acted += 1;
    this.o.store.saveState(follow.id, folded.state, {
      ...status,
      linked: true,
      note: `mirrored ${plan.side} ${sized.quantity}`,
    });
  }

  /** Run until stopped. Each cycle is independent, so one failure costs a tick. */
  async run(intervalMs: number, stopped: () => boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (!stopped()) {
      const report = await this.cycle();
      if (report.follows > 0) {
        this.log(
          `cycle: ${report.follows} follow(s), ${report.acted} mirrored, ${report.skipped} held, ${report.errors} failed`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    this.running = false;
  }
}
