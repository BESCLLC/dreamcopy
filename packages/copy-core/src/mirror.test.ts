// The mirroring decision decides what order gets sent on somebody's account,
// so the cases that matter are the ones where it must decline to send one.

import { describe, expect, it } from "vitest";
import { mirrorTarget, scaleBy, type MirrorPolicy } from "./mirror.js";

const DEC = 8;
const SCALE = 10 ** DEC;
const raw = (n: number) => BigInt(Math.round(n * SCALE));

const policy = (over: Partial<MirrorPolicy> = {}): MirrorPolicy => ({
  ratio: 0.1,
  maxNotional: 1_000_000,
  minGap: 0,
  anchor: 0n,
  lotSize: raw(0.01),
  minQuantity: raw(0.01),
  baseDecimals: DEC,
  ...over,
});

describe("scaleBy", () => {
  it("scales a signed size and keeps its direction", () => {
    expect(scaleBy(raw(10), 0.1)).toBe(raw(1));
    expect(scaleBy(raw(-10), 0.1)).toBe(raw(-1));
  });
});

describe("mirrorTarget", () => {
  it("opens in the leader's direction, scaled by the ratio", () => {
    const p = mirrorTarget({ leaderNet: raw(10), ours: 0n, mark: 100, policy: policy() });
    expect(p.act).toBe(true);
    expect(p.side).toBe("long");
    expect(p.target).toBe(raw(1));
    expect(p.magnitude).toBe(raw(1));
  });

  it("mirrors a short the same way", () => {
    const p = mirrorTarget({ leaderNet: raw(-10), ours: 0n, mark: 100, policy: policy() });
    expect(p.side).toBe("short");
    expect(p.target).toBe(raw(-1));
  });

  it("does nothing when the position already matches", () => {
    const p = mirrorTarget({ leaderNet: raw(10), ours: raw(1), mark: 100, policy: policy() });
    expect(p.act).toBe(false);
    expect(p.reason).toBe("in-line");
    expect(p.magnitude).toBe(0n);
  });

  it("sells to come back down when the leader reduces", () => {
    const p = mirrorTarget({ leaderNet: raw(4), ours: raw(1), mark: 100, policy: policy() });
    expect(p.side).toBe("short");
    expect(p.target).toBe(raw(0.4));
    expect(p.magnitude).toBe(raw(0.6));
  });

  it("closes completely when the leader's movement nets back to zero", () => {
    const p = mirrorTarget({ leaderNet: 0n, ours: raw(1), mark: 100, policy: policy() });
    expect(p.target).toBe(0n);
    expect(p.side).toBe("short");
    expect(p.magnitude).toBe(raw(1));
  });

  it("caps the target by value, not by contract count", () => {
    // 10 units at 100 is 1000 of notional; a 500 cap allows 5.
    const p = mirrorTarget({
      leaderNet: raw(100),
      ours: 0n,
      mark: 100,
      policy: policy({ ratio: 1, maxNotional: 500 }),
    });
    expect(Number(p.target) / SCALE).toBeCloseTo(5, 6);
  });

  it("measures the target from the anchor, so an inherited position is not sold", () => {
    // Holding 2 already, leader has not moved: the target is what we hold.
    const p = mirrorTarget({ leaderNet: 0n, ours: raw(2), mark: 100, policy: policy({ anchor: raw(2) }) });
    expect(p.act).toBe(false);
    expect(p.reason).toBe("in-line");
  });

  it("adds the leader's movement on top of the anchor", () => {
    const p = mirrorTarget({ leaderNet: raw(10), ours: raw(2), mark: 100, policy: policy({ anchor: raw(2) }) });
    expect(p.target).toBe(raw(3));
    expect(p.side).toBe("long");
    expect(p.magnitude).toBe(raw(1));
  });

  it("will not send an order below the market minimum", () => {
    // A gap of 0.05 survives the 0.01 lot grid but is under the 0.1 minimum,
    // so there IS something to do and the venue still cannot do it.
    const p = mirrorTarget({
      leaderNet: raw(0.05),
      ours: 0n,
      mark: 100,
      policy: policy({ ratio: 1, lotSize: raw(0.01), minQuantity: raw(0.1) }),
    });
    expect(p.magnitude).toBe(raw(0.05));
    expect(p.act).toBe(false);
    expect(p.reason).toBe("below-minimum");
  });

  it("reports a target that rounds away on the lot grid as in line, not as a blocked order", () => {
    // 0.005 is smaller than one 0.01 lot, so the target is zero and there is
    // genuinely nothing to send — a different thing from being blocked.
    const p = mirrorTarget({
      leaderNet: raw(0.05),
      ours: 0n,
      mark: 100,
      policy: policy({ lotSize: raw(0.01), minQuantity: raw(0.1) }),
    });
    expect(p.target).toBe(0n);
    expect(p.reason).toBe("in-line");
  });

  it("holds inside the deadband rather than paying the spread on dust", () => {
    // A gap of 0.02 at a mark of 100 is worth $2, under a $5 deadband.
    const p = mirrorTarget({
      leaderNet: raw(0.2),
      ours: 0n,
      mark: 100,
      policy: policy({ minGap: 5 }),
    });
    expect(p.act).toBe(false);
    expect(p.reason).toBe("deadband");
    expect(p.gapValue).toBeCloseTo(2, 6);
  });

  it("acts once the gap clears the deadband", () => {
    const p = mirrorTarget({
      leaderNet: raw(1),
      ours: 0n,
      mark: 100,
      policy: policy({ minGap: 5 }),
    });
    expect(p.act).toBe(true);
    expect(p.gapValue).toBeCloseTo(10, 6);
  });

  it("aligns the target down to the lot grid", () => {
    const p = mirrorTarget({
      leaderNet: raw(1.37),
      ours: 0n,
      mark: 100,
      policy: policy({ ratio: 1, lotSize: raw(0.1), minQuantity: raw(0.1) }),
    });
    expect(p.target).toBe(raw(1.3));
  });

  it("flips through flat in one order when the leader reverses", () => {
    const p = mirrorTarget({ leaderNet: raw(-10), ours: raw(1), mark: 100, policy: policy() });
    expect(p.target).toBe(raw(-1));
    expect(p.side).toBe("short");
    expect(p.magnitude).toBe(raw(2));
  });
});
