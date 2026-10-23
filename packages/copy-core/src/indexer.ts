// Reading somebody else's trading, which the SDK cannot do.
//
// `exchange.fetchPositions()` only ever answers for the signer, so a copy
// trader has no SDK path to the account it follows. The Somnia indexer does:
// it is an open Hasura endpoint carrying every `Fill` on every pool, which is
// enough to reconstruct any account's position and PnL from first principles.
//
// Two things about the perp rows are load-bearing and were confirmed against
// the live endpoint rather than assumed:
//
//   • `takerSide` / `makerSide` are NULL on perp fills (they carry BUY_YES /
//     SELL_YES on prediction markets). `takerIsBid` is the only populated side
//     signal, so it is the one this file uses.
//   • `AccountMarketPnl` and `AccountMarketVolume` are prediction-market
//     tables and come back EMPTY for perp pools, so the leaderboard cannot be
//     read off them. It is computed from fills in `copy.ts` instead.
//
// For a perp market the indexer's `Market.id` IS the pool address, which is
// what joins these rows to a market loaded through the SDK.

export interface Fill {
  id: string;
  taker: string;
  maker: string;
  /** The only populated side signal on perp fills. Maker is always the opposite. */
  takerIsBid: boolean;
  /** Raw base units (scale with the market's `baseDecimals`). */
  quantity: bigint;
  /** Raw 18-decimal quote price. */
  fillPrice: bigint;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
}

/** The market facts `scan` needs without loading the SDK. */
export interface MarketFacts {
  poolAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  markPrice: number;
  tradeCount: number;
  minQuantity: bigint;
  lotSize: bigint;
}

interface RawFill {
  id: string;
  taker: string | null;
  maker: string | null;
  takerIsBid: boolean | null;
  quantity: string;
  fillPrice: string;
  timestamp: string;
  blockNumber: string;
  logIndex: number;
}

export const HIDEKI_INDEXER = "https://hideki-dev.smk.somnia.host/v1/graphql";

/** One page. Hasura caps rows per request, and a wide page is one round trip instead of five. */
const PAGE = 500;

export class IndexerError extends Error {}

/** Transient failures to retry: the connection itself, a rate limit, a 5xx. */
class TransientIndexerError extends IndexerError {}

const RETRIES = Number(process.env.COPY_INDEXER_RETRIES ?? 2);

async function once<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientIndexerError(`indexer unreachable at ${url}: ${(err as Error).message}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TransientIndexerError(`indexer HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.ok) throw new IndexerError(`indexer HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  // A rejected query is deterministic: the same request will be rejected again.
  if (body.errors?.length) throw new IndexerError(`indexer rejected the query: ${body.errors[0]?.message}`);
  if (!body.data) throw new IndexerError("indexer returned no data");
  return body.data;
}

/**
 * One query, retried through a blip.
 *
 * Without this a single dropped connection fails the whole cycle, and a cycle
 * that does not run is a position that is not checked. Only transient faults
 * are retried; a malformed query is not going to succeed on the third attempt.
 */
async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      return await once<T>(url, query, variables);
    } catch (err) {
      last = err;
      if (!(err instanceof TransientIndexerError) || attempt === RETRIES) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw last;
}

/** Addresses are stored lowercase; a checksummed filter silently matches nothing. */
export const norm = (addr: string): string => addr.trim().toLowerCase();

function parseFill(r: RawFill): Fill {
  return {
    id: r.id,
    taker: (r.taker ?? "").toLowerCase(),
    maker: (r.maker ?? "").toLowerCase(),
    takerIsBid: r.takerIsBid ?? false,
    quantity: BigInt(r.quantity),
    fillPrice: BigInt(r.fillPrice),
    timestamp: Number(r.timestamp),
    blockNumber: Number(r.blockNumber),
    logIndex: r.logIndex,
  };
}

const FILL_FIELDS = "id taker maker takerIsBid quantity fillPrice timestamp blockNumber logIndex";

/** Market facts straight from the indexer, so the scanner needs no chain access. */
export async function fetchMarketFacts(url: string, pool: string): Promise<MarketFacts | undefined> {
  const data = await gql<{ Market: Array<Record<string, string | number | null>> }>(
    url,
    `query ($id: String!) {
       Market(where: { id: { _eq: $id } }, limit: 1) {
         poolAddress baseSymbol quoteSymbol baseDecimals markPrice tradeCount minQuantity lotSize
       }
     }`,
    { id: norm(pool) },
  );
  const m = data.Market[0];
  if (!m) return undefined;
  return {
    poolAddress: String(m.poolAddress),
    baseSymbol: String(m.baseSymbol ?? "?"),
    quoteSymbol: String(m.quoteSymbol ?? "USDso"),
    baseDecimals: Number(m.baseDecimals ?? 18),
    markPrice: m.markPrice == null ? NaN : Number(m.markPrice) / 1e18,
    tradeCount: Number(m.tradeCount ?? 0),
    minQuantity: BigInt(m.minQuantity ?? 0),
    lotSize: BigInt(m.lotSize ?? 0),
  };
}

/** Every perp market the venue has registered, busiest first. */
export async function fetchPerpMarkets(url: string, limit = 50): Promise<MarketFacts[]> {
  const data = await gql<{ Market: Array<Record<string, string | number | null>> }>(
    url,
    `query ($limit: Int!) {
       Market(where: { perpRegistered: { _eq: true } }, order_by: { tradeCount: desc }, limit: $limit) {
         poolAddress baseSymbol quoteSymbol baseDecimals markPrice tradeCount minQuantity lotSize
       }
     }`,
    { limit },
  );
  return data.Market.map((m) => ({
    poolAddress: String(m.poolAddress),
    baseSymbol: String(m.baseSymbol ?? "?"),
    quoteSymbol: String(m.quoteSymbol ?? "USDso"),
    baseDecimals: Number(m.baseDecimals ?? 18),
    markPrice: m.markPrice == null ? NaN : Number(m.markPrice) / 1e18,
    tradeCount: Number(m.tradeCount ?? 0),
    minQuantity: BigInt(m.minQuantity ?? 0),
    lotSize: BigInt(m.lotSize ?? 0),
  }));
}

/**
 * The most recent `limit` fills on a pool, returned oldest-first.
 *
 * The window is what the leaderboard is computed over: every account that
 * traded in it is a candidate, and position accounting runs forward through it.
 */
export async function fetchRecentFills(url: string, pool: string, limit: number): Promise<Fill[]> {
  const out: Fill[] = [];
  for (let offset = 0; offset < limit; offset += PAGE) {
    const data = await gql<{ Fill: RawFill[] }>(
      url,
      `query ($pool: String!, $limit: Int!, $offset: Int!) {
         Fill(where: { pool: { _eq: $pool } },
              order_by: [{ timestamp: desc }, { logIndex: desc }],
              limit: $limit, offset: $offset) { ${FILL_FIELDS} }
       }`,
      { pool: norm(pool), limit: Math.min(PAGE, limit - offset), offset },
    );
    out.push(...data.Fill.map(parseFill));
    if (data.Fill.length < PAGE) break;
  }
  // Fetched newest-first for the window, replayed oldest-first for accounting.
  return out.reverse();
}

/**
 * One account's fills on a pool, oldest first.
 *
 * `sinceTimestamp` makes the polling path incremental: the loop re-reads only
 * what is new instead of the whole history every cycle. `cap` bounds the
 * startup read, because a market maker's history is unbounded and a copy
 * trader only needs the net it adds up to.
 */
export async function fetchAccountFills(
  url: string,
  pool: string,
  account: string,
  opts: { sinceTimestamp?: number; cap?: number } = {},
): Promise<Fill[]> {
  const cap = opts.cap ?? 5_000;
  const since = opts.sinceTimestamp ?? 0;
  const out: Fill[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const data = await gql<{ Fill: RawFill[] }>(
      url,
      `query ($pool: String!, $account: String!, $since: numeric!, $limit: Int!, $offset: Int!) {
         Fill(where: { pool: { _eq: $pool },
                       timestamp: { _gte: $since },
                       _or: [{ taker: { _eq: $account } }, { maker: { _eq: $account } }] },
              order_by: [{ timestamp: asc }, { logIndex: asc }],
              limit: $limit, offset: $offset) { ${FILL_FIELDS} }
       }`,
      { pool: norm(pool), account: norm(account), since, limit: Math.min(PAGE, cap - offset), offset },
    );
    out.push(...data.Fill.map(parseFill));
    if (data.Fill.length < PAGE) break;
  }
  return out;
}
