// The one decision a copy trader makes, in one place.
//
// Given what the leader has done, what we hold, and the follower's policy:
// what should we be holding, and what order closes the difference?
//
// This is deliberately pure and shared. The CLI follows one leader and the
// hosted service follows many on behalf of many accounts, but if those two
// disagreed about what "mirroring" means, one of them would be wrong — and the
// wrong one would be moving somebody's real position.

import { alignToLot, clampToNotional } from "./copy.js";

/** Scale a signed raw size by a fractional ratio without leaving integer maths. */
export function scaleBy(raw: bigint, ratio: number): bigint {
  const bps = BigInt(Math.max(0, Math.round(ratio * 10_000)));
  return (raw * bps) / 10_000n;
}

export interface MirrorPolicy {
  /** Fraction of the leader's size to mirror. */
  ratio: number;
  /** Cap on position VALUE, which is the limit a follower actually cares about. */
  maxNotional: number;
  /** Ignore adjustments worth less than this, so dust does not pay the spread. */
  minGap: number;
  /** Our position when following began; the target is measured from here. */
  anchor: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  baseDecimals: number;
}

export type MirrorReason = "in-line" | "below-minimum" | "deadband" | "act";

export interface MirrorPlan {
  /** Where the position should be, aligned to the lot grid. */
  target: bigint;
  /** Signed difference from where it is. */
  gap: bigint;
  /** |gap|, which is the order size. */
  magnitude: bigint;
  /** What that gap is worth, in quote terms. */
  gapValue: number;
  /** Which way the order goes, when there is one. */
  side?: "long" | "short";
  act: boolean;
  reason: MirrorReason;
}

/**
 * Work out the order that brings us in line.
 *
 * Mirrors a POSITION rather than an order feed: the target is recomputed from
 * scratch every time, so a missed poll, a partial fill or a restart converges
 * on the next cycle instead of drifting away permanently.
 */
export function mirrorTarget(args: {
  /** The leader's movement since following began (their whole position in follow-existing mode). */
  leaderNet: bigint;
  /** What we hold now, signed. */
  ours: bigint;
  mark: number;
  policy: MirrorPolicy;
}): MirrorPlan {
  const { leaderNet, ours, mark, policy } = args;
  const scale = 10 ** policy.baseDecimals;

  const target = alignToLot(
    clampToNotional(
      policy.anchor + scaleBy(leaderNet, policy.ratio),
      mark,
      policy.maxNotional,
      policy.baseDecimals,
    ),
    policy.lotSize,
  );

  const gap = alignToLot(target - ours, policy.lotSize);
  const magnitude = gap < 0n ? -gap : gap;
  const gapValue = Number.isFinite(mark) ? (Number(magnitude) / scale) * mark : 0;

  if (magnitude === 0n) return { target, gap, magnitude, gapValue, act: false, reason: "in-line" };
  // The venue has no order smaller than its minimum, so a smaller gap is not
  // actionable at all — it is not a deadband decision.
  if (magnitude < policy.minQuantity) {
    return { target, gap, magnitude, gapValue, act: false, reason: "below-minimum" };
  }
  // Crossing the spread for a few cents of alignment costs more than the drift
  // it corrects, and it would repeat every cycle.
  if (gapValue < policy.minGap) {
    return { target, gap, magnitude, gapValue, act: false, reason: "deadband" };
  }

  return {
    target,
    gap,
    magnitude,
    gapValue,
    side: gap > 0n ? "long" : "short",
    act: true,
    reason: "act",
  };
}
