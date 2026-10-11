/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Funding, read the way the contract means it.
//
// The stored rate covers the CALCULATION WINDOW, not one settlement interval.
// Reading it as per-interval overstates the annualised figure by the number of
// intervals in a window, which on the live markets is eight. The SDK's
// converters truncate the way the contract's integer arithmetic does, so they
// are used here rather than dividing by hand.

import { annualizedFundingRate, fundingRatePerInterval, type SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { PerpInfo, PerpMarket } from "./markets.js";
import type { Side } from "./orders.js";

export interface FundingView {
  /** Annualised, as a fraction: 0.01 is 1% APR. */
  apr: number;
  /** What settles each interval, raw 1e18-scaled. */
  perInterval: bigint;
  /** Positive means longs pay shorts. */
  positive: boolean;
  /** The side funding currently PAYS. */
  paidSide: Side;
  windowSec: number;
  intervalSec: number;
  /**
   * False when there was no window to read the rate against, so `apr` is a
   * placeholder 0 rather than a measurement. A newly listed market has no
   * indexed funding until its first settlement.
   */
  known: boolean;
}

function viewOf(rate: bigint, windowSec: number, intervalSec: number): FundingView {
  // The window is the rate's denominator, and the SDK refuses to divide by a
  // missing one. A pool listed before its first settlement has an indexed row
  // with no funding fields at all.
  if (!(windowSec > 0) || !(intervalSec > 0)) {
    return { apr: 0, perInterval: 0n, positive: false, paidSide: "long", windowSec, intervalSec, known: false };
  }
  return {
    apr: annualizedFundingRate(rate, windowSec),
    perInterval: fundingRatePerInterval(rate, windowSec, intervalSec),
    positive: rate > 0n,
    // Positive funding is longs paying shorts, so the side that GETS paid is
    // the short one. A carry strategy takes the paid side and nothing else.
    paidSide: rate > 0n ? "short" : "long",
    windowSec,
    intervalSec,
    known: true,
  };
}

/** Read the market row's funding state. */
export function fundingApr(info: PerpInfo): FundingView {
  return viewOf(BigInt(info.fundingRate ?? 0), Number(info.fundingWindowSec), Number(info.fundingIntervalSec));
}

/**
 * Funding as the pool holds it now, falling back to the market row.
 *
 * The row only moves on a settlement, and a newly listed market has none yet,
 * so its row carries no rate and no window while the pool already has both.
 * The pool's own numbers are the ones a position settles against.
 */
export async function liveFunding(exchange: SomniaMarkets, market: PerpMarket): Promise<FundingView> {
  try {
    const state = await exchange.client.getPerpState(market.info.poolAddress);
    return viewOf(state.fundingRate, Number(state.fundingWindowSec), Number(state.fundingIntervalSec));
  } catch {
    return fundingApr(market.info);
  }
}

/**
 * The side worth holding for carry, or undefined when the rate does not clear
 * the threshold.
 *
 * `minApr` is compared against the ABSOLUTE rate, because a large negative rate
 * pays longs exactly as a large positive one pays shorts.
 */
export function fundingSide(info: PerpInfo, minApr: number): Side | undefined {
  const view = fundingApr(info);
  return Math.abs(view.apr) >= minApr ? view.paidSide : undefined;
}
