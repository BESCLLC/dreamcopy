// The position and PnL maths, which is the part that has to be right.
//
// Every number dreamCopy acts on comes out of `replay`, and the subtle cases
// (a maker's side, a partial close, a flip through flat, a short's unrealised)
// are exactly the ones that look fine until real money is on them.

import { describe, expect, it } from "vitest";
import { alignToLot, buildLeaderboard, clampToNotional, netPosition, replay, signedQty } from "./copy.js";
import type { Fill } from "./indexer.js";

const DEC = 8;
const SCALE = 10 ** DEC;
const LEADER = "0xleader";
const OTHER = "0xother";

/** `qty` and `price` in human units; the fixture scales them like the indexer does. */
function fill(opts: {
  qty: number;
  price: number;
  takerIsBid: boolean;
  taker?: string;
  maker?: string;
  t?: number;
}): Fill {
  return {
    id: `${opts.taker ?? LEADER}-${opts.t ?? 0}-${opts.qty}-${opts.price}-${Math.random()}`,
    taker: opts.taker ?? LEADER,
    maker: opts.maker ?? OTHER,
    takerIsBid: opts.takerIsBid,
    quantity: BigInt(Math.round(opts.qty * SCALE)),
    fillPrice: BigInt(Math.round(opts.price * 1e18)),
    timestamp: opts.t ?? 0,
    blockNumber: 1,
    logIndex: 0,
  };
}

describe("signedQty", () => {
  it("counts a taker's buy as positive and their sell as negative", () => {
    expect(signedQty(fill({ qty: 1, price: 100, takerIsBid: true }), LEADER)).toBe(BigInt(SCALE));
    expect(signedQty(fill({ qty: 1, price: 100, takerIsBid: false }), LEADER)).toBe(-BigInt(SCALE));
  });

  it("puts the maker on the opposite side of the taker", () => {
    // takerIsBid = the taker bought, so the maker sold.
    const f = fill({ qty: 1, price: 100, takerIsBid: true, taker: OTHER, maker: LEADER });
    expect(signedQty(f, LEADER)).toBe(-BigInt(SCALE));
  });

  it("is exact in raw units, with no float rounding", () => {
    const f = fill({ qty: 0.00000001, price: 100, takerIsBid: true });
    expect(signedQty(f, LEADER)).toBe(1n);
  });
});

describe("netPosition", () => {
  it("nets buys against sells and lands exactly flat", () => {
    const fills = [
      fill({ qty: 1.5, price: 100, takerIsBid: true }),
      fill({ qty: 0.5, price: 110, takerIsBid: false }),
      fill({ qty: 1, price: 120, takerIsBid: false }),
    ];
    expect(netPosition(fills, LEADER)).toBe(0n);
  });
});

describe("replay", () => {
  it("averages the entry when adding to a position", () => {
    const r = replay(
      [fill({ qty: 1, price: 100, takerIsBid: true }), fill({ qty: 1, price: 200, takerIsBid: true })],
      LEADER,
      DEC,
      200,
    );
    expect(r.avgEntry).toBeCloseTo(150, 8);
    expect(r.netHuman).toBeCloseTo(2, 8);
    expect(r.realized).toBeCloseTo(0, 8);
  });

  it("realises a long's profit on the way out and clears the entry when flat", () => {
    const r = replay(
      [fill({ qty: 1, price: 100, takerIsBid: true }), fill({ qty: 1, price: 110, takerIsBid: false })],
      LEADER,
      DEC,
      110,
    );
    expect(r.realized).toBeCloseTo(10, 8);
    expect(r.net).toBe(0n);
    // A stale average on a closed position would show a phantom unrealised PnL.
    expect(r.avgEntry).toBe(0);
    expect(r.unrealized).toBe(0);
  });

  it("realises only the part that actually closes", () => {
    const r = replay(
      [fill({ qty: 2, price: 100, takerIsBid: true }), fill({ qty: 1, price: 120, takerIsBid: false })],
      LEADER,
      DEC,
      120,
    );
    expect(r.realized).toBeCloseTo(20, 8);
    expect(r.netHuman).toBeCloseTo(1, 8);
    expect(r.avgEntry).toBeCloseTo(100, 8);
    expect(r.unrealized).toBeCloseTo(20, 8);
  });

  it("makes money on a short when the price falls", () => {
    const r = replay(
      [fill({ qty: 1, price: 100, takerIsBid: false }), fill({ qty: 1, price: 90, takerIsBid: true })],
      LEADER,
      DEC,
      90,
    );
    expect(r.realized).toBeCloseTo(10, 8);
    expect(r.net).toBe(0n);
  });

  it("prices a short's unrealised PnL the right way round", () => {
    const r = replay([fill({ qty: 1, price: 100, takerIsBid: false })], LEADER, DEC, 90);
    expect(r.netHuman).toBeCloseTo(-1, 8);
    expect(r.unrealized).toBeCloseTo(10, 8);
  });

  it("re-opens at the fill price when a trade flips through flat", () => {
    // Long 1 @100, then sell 3 @120: 1 closes for +20, and 2 open short at 120.
    const r = replay(
      [fill({ qty: 1, price: 100, takerIsBid: true }), fill({ qty: 3, price: 120, takerIsBid: false })],
      LEADER,
      DEC,
      120,
    );
    expect(r.realized).toBeCloseTo(20, 8);
    expect(r.netHuman).toBeCloseTo(-2, 8);
    expect(r.avgEntry).toBeCloseTo(120, 8);
    expect(r.unrealized).toBeCloseTo(0, 8);
  });

  it("reports taker share, which is how a market maker is spotted", () => {
    const r = replay(
      [
        fill({ qty: 1, price: 100, takerIsBid: true }),
        fill({ qty: 1, price: 100, takerIsBid: true, taker: OTHER, maker: LEADER }),
      ],
      LEADER,
      DEC,
      100,
    );
    expect(r.takerShare).toBeCloseTo(0.5, 8);
  });
});

describe("buildLeaderboard", () => {
  it("ranks by total PnL and leaves out the excluded account", () => {
    const fills = [
      // LEADER buys at 100 from OTHER, then sells at 120 back to OTHER.
      fill({ qty: 1, price: 100, takerIsBid: true, taker: LEADER, maker: OTHER, t: 1 }),
      fill({ qty: 1, price: 120, takerIsBid: false, taker: LEADER, maker: OTHER, t: 2 }),
    ];
    const ranked = buildLeaderboard(fills, DEC, 120, { exclude: [OTHER] });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.account).toBe(LEADER);
    expect(ranked[0]?.realized).toBeCloseTo(20, 8);
  });

  it("drops accounts below the volume floor", () => {
    const fills = [fill({ qty: 0.01, price: 100, takerIsBid: true })];
    expect(buildLeaderboard(fills, DEC, 100, { minVolume: 500 })).toHaveLength(0);
  });
});

describe("clampToNotional", () => {
  it("caps a target by the value it implies, not its size", () => {
    // 10 units at 100 is 1000 of notional; a 500 cap allows 5.
    const capped = clampToNotional(BigInt(10 * SCALE), 100, 500, DEC);
    expect(Number(capped) / SCALE).toBeCloseTo(5, 6);
  });

  it("caps a short in the same way, keeping its direction", () => {
    const capped = clampToNotional(-BigInt(10 * SCALE), 100, 500, DEC);
    expect(Number(capped) / SCALE).toBeCloseTo(-5, 6);
  });

  it("leaves a target that is already within the cap alone", () => {
    const target = BigInt(2 * SCALE);
    expect(clampToNotional(target, 100, 500, DEC)).toBe(target);
  });
});

describe("alignToLot", () => {
  it("rounds down to the lot grid, towards zero on both sides", () => {
    const lot = BigInt(0.1 * SCALE);
    expect(alignToLot(BigInt(Math.round(1.37 * SCALE)), lot)).toBe(BigInt(Math.round(1.3 * SCALE)));
    expect(alignToLot(BigInt(Math.round(-1.37 * SCALE)), lot)).toBe(BigInt(Math.round(-1.3 * SCALE)));
  });

  it("sends a size below one lot to zero rather than rounding it up", () => {
    const lot = BigInt(0.1 * SCALE);
    expect(alignToLot(BigInt(Math.round(0.07 * SCALE)), lot)).toBe(0n);
  });
});
