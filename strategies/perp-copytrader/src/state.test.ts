// The state file is what stops a restart from closing a position the bot did
// not open, so the cases that matter are the ones where it must REFUSE to be
// applied: a different leader, a different market, a bad file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState, saveState, type StateKey } from "./state.js";

const KEY: StateKey = {
  network: "hideki",
  symbol: "BTC-PERP",
  leader: "0xabc0000000000000000000000000000000000001",
  followExisting: false,
};

const dir = () => mkdtempSync(join(tmpdir(), "dreamcopy-state-"));

const state = () => ({ leaderNet: 12345n, since: 1792770481, boundary: new Set(["a", "b"]) });

describe("state", () => {
  it("round-trips the follow state and the anchor", () => {
    const d = dir();
    saveState(d, KEY, state(), -999n);
    const back = loadState(d, KEY);
    expect(back?.state.leaderNet).toBe(12345n);
    expect(back?.state.since).toBe(1792770481);
    expect([...(back?.state.boundary ?? [])].sort()).toEqual(["a", "b"]);
    // A negative anchor is a short, and it has to survive the string round trip.
    expect(back?.anchor).toBe(-999n);
  });

  it("returns nothing when no state was ever written", () => {
    expect(loadState(dir(), KEY)).toBeUndefined();
  });

  it("refuses state written for a different leader", () => {
    const d = dir();
    saveState(d, KEY, state(), 0n);
    const other = { ...KEY, leader: "0xabc0000000000000000000000000000000000002" };
    expect(loadState(d, other)).toBeUndefined();
  });

  it("refuses state written for a different market or network", () => {
    const d = dir();
    saveState(d, KEY, state(), 0n);
    expect(loadState(d, { ...KEY, symbol: "ETH-PERP" })).toBeUndefined();
    expect(loadState(d, { ...KEY, network: "testnet" })).toBeUndefined();
  });

  it("refuses state written under a different follow mode", () => {
    const d = dir();
    saveState(d, KEY, state(), 0n);
    expect(loadState(d, { ...KEY, followExisting: true })).toBeUndefined();
  });

  it("treats a corrupt file as absent rather than throwing", () => {
    const d = dir();
    saveState(d, KEY, state(), 0n);
    const safe = `${KEY.network}-${KEY.symbol}-${KEY.leader}`.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    writeFileSync(join(d, `copytrader-${safe}.json`), "{ this is not json");
    expect(() => loadState(d, KEY)).not.toThrow();
    expect(loadState(d, KEY)).toBeUndefined();
  });

  it("is case-insensitive about the leader address", () => {
    const d = dir();
    saveState(d, KEY, state(), 0n);
    expect(loadState(d, { ...KEY, leader: KEY.leader.toUpperCase() })).toBeDefined();
  });
});
