// The HTTP surface: a read-only view of the venue, plus the two writes that
// start and stop a follow.
//
// Starting a follow means this service will place orders on the named account,
// so the request has to prove that account consented. It is signed by the
// owner's wallet and verified here. Without that, anyone could enrol anyone
// else's address — and while the orders would still fail unless that account
// had linked the key, enrolling a stranger is not a thing an API should allow.
//
// Built on node:http on purpose. The routing a service this size needs is a
// switch, and a framework would be the heaviest dependency in the repo.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { buildLeaderboard, fetchPerpMarkets, fetchRecentFills, norm } from "@dreamdex-bot-kit/copy-core";
import { isAddress, verifyMessage } from "viem";
import type { Keeper } from "./engine.js";
import { FollowStore, type FollowPolicy } from "./store.js";

export interface ServerOptions {
  store: FollowStore;
  keeper: Keeper;
  indexerUrl: string;
  network: string;
  dryRun: boolean;
  webRoot: string;
  /** Resolve a market symbol + facts the follow record needs. */
  resolveMarket: (query: string) => Promise<{ symbol: string; name: string; pool: string; baseDecimals: number } | undefined>;
  /** Exact signed position for an account, used to anchor a new follow. */
  positionOf: (symbol: string, owner: string) => Promise<bigint>;
}

/** How long a signed request stays good. Long enough to sign, short enough not to be replayed later. */
const SIGNATURE_TTL_MS = 10 * 60 * 1000;

/** The exact text a follower signs. Rebuilt here and compared, never trusted from the body. */
export function followMessage(p: {
  action: "follow" | "unfollow";
  owner: string;
  market: string;
  leader: string;
  issued: string;
}): string {
  return [
    "dreamCopy",
    `action: ${p.action}`,
    `owner: ${p.owner.toLowerCase()}`,
    `market: ${p.market}`,
    `leader: ${p.leader.toLowerCase()}`,
    `issued: ${p.issued}`,
  ].join("\n");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A follow request is a few hundred bytes; anything larger is not one.
    if (size > 64_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Verify the owner signed this exact action, recently. */
async function requireSignature(
  body: Record<string, unknown>,
  action: "follow" | "unfollow",
): Promise<{ owner: string; market: string; leader: string }> {
  const owner = String(body.owner ?? "");
  const market = String(body.market ?? "");
  const leader = String(body.leader ?? "");
  const issued = String(body.issued ?? "");
  const signature = String(body.signature ?? "");

  if (!isAddress(owner)) throw new Error("owner is not an address");
  if (!isAddress(leader)) throw new Error("leader is not an address");
  if (!market) throw new Error("market is required");
  if (!signature.startsWith("0x")) throw new Error("signature is required");

  const at = Date.parse(issued);
  if (!Number.isFinite(at)) throw new Error("issued is not a timestamp");
  if (Math.abs(Date.now() - at) > SIGNATURE_TTL_MS) throw new Error("signature has expired, sign again");

  const ok = await verifyMessage({
    address: owner as `0x${string}`,
    message: followMessage({ action, owner, market, leader, issued }),
    signature: signature as `0x${string}`,
  });
  if (!ok) throw new Error("signature does not match owner");
  return { owner: norm(owner), market, leader: norm(leader) };
}

function policyFrom(body: Record<string, unknown>): FollowPolicy {
  const ratio = Number(body.ratio ?? 0.1);
  const maxNotional = Number(body.maxNotional ?? 100);
  const minGap = Number(body.minGap ?? 1);
  if (!(ratio > 0) || ratio > 10) throw new Error("ratio must be greater than 0 and at most 10");
  if (!(maxNotional > 0)) throw new Error("maxNotional must be greater than 0");
  if (minGap < 0) throw new Error("minGap cannot be negative");
  return { ratio, maxNotional, minGap };
}

export function createDreamCopyServer(o: ServerOptions) {
  async function serveStatic(url: string, res: ServerResponse): Promise<void> {
    const rel = url === "/" ? "index.html" : normalize(url).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
    const file = join(o.webRoot, rel);
    // Never serve outside the web root, whatever the path claims.
    if (!file.startsWith(o.webRoot)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (!path.startsWith("/api/")) return await serveStatic(path, res);

      if (req.method === "GET" && path === "/api/status") {
        return send(res, 200, {
          network: o.network,
          dryRun: o.dryRun,
          operator: o.keeper.operatorAddress ?? null,
          lastCycle: o.keeper.report ?? null,
          follows: o.store.list().length,
          activeFollows: o.store.active().length,
        });
      }

      if (req.method === "GET" && path === "/api/markets") {
        const markets = await fetchPerpMarkets(o.indexerUrl, 50);
        return send(res, 200, {
          markets: markets.map((m) => ({
            name: `${m.baseSymbol}-PERP`,
            baseSymbol: m.baseSymbol,
            quoteSymbol: m.quoteSymbol,
            pool: m.poolAddress,
            markPrice: m.markPrice,
            tradeCount: m.tradeCount,
          })),
        });
      }

      if (req.method === "GET" && path === "/api/leaderboard") {
        const query = url.searchParams.get("market") ?? "BTC";
        const window = Math.min(5_000, Number(url.searchParams.get("window") ?? 2_000));
        const market = await o.resolveMarket(query);
        if (!market) return send(res, 404, { error: `no perp market matches ${query}` });

        const markets = await fetchPerpMarkets(o.indexerUrl, 50);
        const facts = markets.find((m) => m.poolAddress.toLowerCase() === market.pool.toLowerCase());
        const fills = await fetchRecentFills(o.indexerUrl, market.pool, window);
        const ranked = buildLeaderboard(fills, market.baseDecimals, facts?.markPrice ?? NaN, {
          minVolume: Number(url.searchParams.get("minVolume") ?? 500),
          minTakerShare: Number(url.searchParams.get("minTakerShare") ?? 0.1),
        });
        return send(res, 200, {
          market: { name: market.name, symbol: market.symbol, pool: market.pool, markPrice: facts?.markPrice ?? null },
          window: fills.length,
          traders: ranked.slice(0, 25).map((r) => ({
            account: r.account,
            position: r.netHuman,
            avgEntry: r.avgEntry,
            realized: r.realized,
            unrealized: r.unrealized,
            total: r.total,
            volume: r.volume,
            takerShare: r.takerShare,
            fills: r.fills,
            lastTimestamp: r.lastTimestamp,
          })),
        });
      }

      if (req.method === "GET" && path === "/api/follows") {
        const owner = url.searchParams.get("owner");
        if (!owner || !isAddress(owner)) return send(res, 400, { error: "owner query parameter must be an address" });
        return send(res, 200, { follows: o.store.byOwner(owner) });
      }

      if (req.method === "POST" && path === "/api/follows") {
        const body = await readBody(req);
        const signed = await requireSignature(body, "follow");
        const policy = policyFrom(body);
        const market = await o.resolveMarket(signed.market);
        if (!market) return send(res, 404, { error: `no perp market matches ${signed.market}` });
        if (signed.leader === signed.owner) {
          return send(res, 400, { error: "copying your own account compounds your position" });
        }
        // Anchor on what they already hold, so enrolling never sells a position
        // this service did not open.
        const anchor = await o.positionOf(market.symbol, signed.owner);
        const follow = o.store.upsert({
          owner: signed.owner,
          market: market.symbol,
          marketName: market.name,
          leader: signed.leader,
          policy,
          anchor,
          since: Math.floor(Date.now() / 1000),
        });
        return send(res, 200, { follow });
      }

      if (req.method === "POST" && path === "/api/follows/stop") {
        const body = await readBody(req);
        const signed = await requireSignature(body, "unfollow");
        const market = await o.resolveMarket(signed.market);
        if (!market) return send(res, 404, { error: `no perp market matches ${signed.market}` });
        const id = `${signed.owner}:${market.symbol}:${signed.leader}`.toLowerCase();
        const follow = o.store.deactivate(id);
        if (!follow) return send(res, 404, { error: "no such follow" });
        return send(res, 200, { follow });
      }

      return send(res, 404, { error: "no such endpoint" });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  });
}
