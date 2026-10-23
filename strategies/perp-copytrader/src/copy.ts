// Turning a stream of fills into a position, a PnL and a leaderboard.
//
// This is the part the venue does not hand you. `AccountMarketPnl` is a
// prediction-market table and is empty for perps, so "who is winning this
// market" has to be derived from the only perp-complete source there is: the
// fills themselves, replayed through average-cost accounting.
//
// Sizes stay in raw base units as bigints wherever an order depends on them,
// because that is what the pool accepts and float drift there becomes a
// rejected or wrongly-sized order. Money is accounted in floats, because it is
// only ever read by a human.

import type { Fill } from "./indexer.js";

/**
 * The account's signed size change from one fill, in raw base units.
 *
 * `takerIsBid` is the only side flag perp fills populate, and the maker is by
 * definition on the other side of it. Buying is positive whichever role the
 * account played.
 */
export function signedQty(fill: Fill, account: string): bigint {
  const isTaker = fill.taker === account;
  const isBid = isTaker ? fill.takerIsBid : !fill.takerIsBid;
  return isBid ? fill.quantity : -fill.quantity;
}

/** Net signed position in raw base units. Exact: no float ever touches it. */
export function netPosition(fills: Fill[], account: string): bigint {
  let net = 0n;
  for (const f of fills) net += signedQty(f, account);
  return net;
}

export interface Replay {
  account: string;
  /** Exact signed position in raw base units. */
  net: bigint;
  /** The same position as a human number, for display and PnL. */
  netHuman: number;
  /** Average entry of the open position, 0 when flat. */
  avgEntry: number;
  realized: number;
  unrealized: number;
  total: number;
  /** Quote volume traded in the window, which is how "big enough to follow" is judged. */
  volume: number;
  fills: number;
  /** Share of fills where the account crossed the spread. Makers are near 0. */
  takerShare: number;
  lastTimestamp: number;
}

/**
 * Replay one account's fills through average-cost accounting.
 *
 * A reduction realises against the running average; a fill that crosses
 * through flat realises only the closing part and re-opens the remainder at
 * the fill price, which is what keeps a flip from inventing PnL.
 */
export function replay(fills: Fill[], account: string, baseDecimals: number, mark: number): Replay {
  const scale = 10 ** baseDecimals;
  let net = 0n;
  let pos = 0;
  let avgEntry = 0;
  let realized = 0;
  let volume = 0;
  let takers = 0;
  let last = 0;

  for (const f of fills) {
    const raw = signedQty(f, account);
    if (raw === 0n) continue;
    // Direction and flatness are decided on the exact integer position. Letting
    // a float accumulator answer "am I flat?" leaves residue after a full close,
    // which keeps a stale average entry on a position that no longer exists.
    const before = net;
    net += raw;
    const price = Number(f.fillPrice) / 1e18;
    const qty = Math.abs(Number(raw)) / scale;
    pos = Number(before) / scale;

    if (before === 0n || raw > 0n === before > 0n) {
      // Opening or adding: the average absorbs the new lot.
      const abs = Math.abs(pos) + qty;
      avgEntry = abs === 0 ? 0 : (Math.abs(pos) * avgEntry + qty * price) / abs;
    } else {
      // Reducing: realise only what actually closes, against the running average.
      const closed = Math.min(Math.abs(pos), qty);
      realized += closed * (price - avgEntry) * (before > 0n ? 1 : -1);
      if (net === 0n) avgEntry = 0;
      // Crossed through flat: the remainder is a new position at this price.
      else if (net > 0n !== before > 0n) avgEntry = price;
    }

    volume += qty * price;
    if (f.taker === account) takers += 1;
    last = Math.max(last, f.timestamp);
  }
  pos = Number(net) / scale;

  // A short gains when the mark falls, which `pos * (mark - entry)` already
  // encodes: both terms flip, so the product does not.
  const unrealized = pos === 0 || !Number.isFinite(mark) ? 0 : pos * (mark - avgEntry);
  return {
    account,
    net,
    netHuman: Number(net) / scale,
    avgEntry,
    realized,
    unrealized,
    total: realized + unrealized,
    volume,
    fills: fills.length,
    takerShare: fills.length === 0 ? 0 : takers / fills.length,
    lastTimestamp: last,
  };
}

export interface LeaderboardOptions {
  /** Ignore accounts too small to be worth mirroring. */
  minVolume?: number;
  /** Drop pure market makers, who have no direction to copy. */
  minTakerShare?: number;
  /** Never rank these (the follower's own account, and its bot key). */
  exclude?: string[];
}

/**
 * Rank the accounts that traded in a window by what they made in it.
 *
 * The PnL is windowed by construction: accounting starts at the first fill in
 * the window, so a position opened before it is treated as opened at its first
 * in-window fill. That is stated rather than hidden, because it is the honest
 * limit of ranking from a bounded read.
 */
export function buildLeaderboard(
  fills: Fill[],
  baseDecimals: number,
  mark: number,
  opts: LeaderboardOptions = {},
): Replay[] {
  const minVolume = opts.minVolume ?? 0;
  const minTakerShare = opts.minTakerShare ?? 0;
  const excluded = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));

  const byAccount = new Map<string, Fill[]>();
  for (const f of fills) {
    for (const account of [f.taker, f.maker]) {
      if (!account || excluded.has(account)) continue;
      const bucket = byAccount.get(account);
      if (bucket) bucket.push(f);
      else byAccount.set(account, [f]);
    }
  }

  return [...byAccount.keys()]
    .map((account) => replay(byAccount.get(account) ?? [], account, baseDecimals, mark))
    .filter((r) => r.volume >= minVolume && r.takerShare >= minTakerShare)
    .sort((a, b) => b.total - a.total);
}

/** Align a signed size DOWN to the market's lot grid, keeping its direction. */
export function alignToLot(raw: bigint, lotSize: bigint): bigint {
  if (lotSize <= 0n) return raw;
  const magnitude = (raw < 0n ? -raw : raw) / lotSize * lotSize;
  return raw < 0n ? -magnitude : magnitude;
}

/**
 * Cap a signed target so the position it implies is never worth more than
 * `maxNotional`. The risk limit a follower actually cares about is the money at
 * stake, not the number of contracts.
 */
export function clampToNotional(
  target: bigint,
  mark: number,
  maxNotional: number,
  baseDecimals: number,
): bigint {
  if (!Number.isFinite(mark) || mark <= 0 || maxNotional <= 0) return target;
  const scale = 10 ** baseDecimals;
  const notional = (Math.abs(Number(target)) / scale) * mark;
  if (notional <= maxNotional) return target;
  const allowed = BigInt(Math.floor((maxNotional / mark) * scale));
  return target < 0n ? -allowed : allowed;
}
