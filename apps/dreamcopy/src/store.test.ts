// The registry decides whose position the keeper moves, so the cases that
// matter are the ones that keep two followers apart and keep a stopped follow
// stopped.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FollowStore, followId, stateOf } from "./store.js";

const ALICE = "0xAAaa0000000000000000000000000000000000a1";
const BOB = "0xBBbb0000000000000000000000000000000000b2";
const LEADER = "0xCCcc0000000000000000000000000000000000c3";
const MARKET = "ETH/USDso:USDso";

const store = () => new FollowStore(join(mkdtempSync(join(tmpdir(), "dreamcopy-")), "follows.json"));

const enrol = (s: FollowStore, owner: string, anchor = 0n, leader = LEADER) =>
  s.upsert({
    owner,
    market: MARKET,
    marketName: "ETH-PERP",
    leader,
    policy: { ratio: 0.1, maxNotional: 100, minGap: 1 },
    anchor,
    since: 1_700_000_000,
  });

describe("followId", () => {
  it("is case-insensitive, so a checksummed address is the same follow", () => {
    expect(followId(ALICE, MARKET, LEADER)).toBe(followId(ALICE.toLowerCase(), MARKET, LEADER.toLowerCase()));
  });
});

describe("FollowStore", () => {
  it("keeps each follower's anchor and cursor separate", () => {
    const s = store();
    enrol(s, ALICE, 500n);
    enrol(s, BOB, -250n);
    const alice = s.byOwner(ALICE)[0]!;
    const bob = s.byOwner(BOB)[0]!;
    // Two people following the same trader do not share a position.
    expect(alice.anchor).toBe("500");
    expect(bob.anchor).toBe("-250");
    expect(alice.id).not.toBe(bob.id);
  });

  it("updates the terms instead of creating a second, competing follow", () => {
    const s = store();
    enrol(s, ALICE);
    s.upsert({
      owner: ALICE,
      market: MARKET,
      marketName: "ETH-PERP",
      leader: LEADER,
      policy: { ratio: 0.5, maxNotional: 999, minGap: 2 },
      anchor: 0n,
      since: 1_700_000_100,
    });
    const mine = s.byOwner(ALICE);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.ratio).toBe(0.5);
    expect(mine[0]?.maxNotional).toBe(999);
  });

  it("re-following preserves the original anchor", () => {
    const s = store();
    enrol(s, ALICE, 500n);
    s.deactivate(followId(ALICE, MARKET, LEADER));
    enrol(s, ALICE, 12345n);
    // The anchor explains a position that already exists; a re-follow must not
    // silently re-base it and start selling the difference.
    expect(s.byOwner(ALICE)[0]?.anchor).toBe("500");
    expect(s.byOwner(ALICE)[0]?.active).toBe(true);
  });

  it("deactivates rather than deleting, so the history survives", () => {
    const s = store();
    enrol(s, ALICE);
    s.deactivate(followId(ALICE, MARKET, LEADER));
    expect(s.active()).toHaveLength(0);
    expect(s.list()).toHaveLength(1);
  });

  it("lets one follower follow several leaders at once", () => {
    const s = store();
    enrol(s, ALICE, 0n, LEADER);
    enrol(s, ALICE, 0n, BOB);
    expect(s.byOwner(ALICE)).toHaveLength(2);
    expect(s.active()).toHaveLength(2);
  });

  it("persists across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dreamcopy-")), "follows.json");
    const first = new FollowStore(path);
    enrol(first, ALICE, 777n);
    first.saveState(
      followId(ALICE, MARKET, LEADER),
      { leaderNet: 4242n, since: 1_700_000_500, boundary: new Set(["x", "y"]) },
      { note: "mirrored" },
    );
    // A keeper that forgot the cursor would recount the leader's moves.
    const reopened = new FollowStore(path);
    const back = reopened.byOwner(ALICE)[0]!;
    expect(back.anchor).toBe("777");
    expect(stateOf(back).leaderNet).toBe(4242n);
    expect(stateOf(back).since).toBe(1_700_000_500);
    expect([...stateOf(back).boundary].sort()).toEqual(["x", "y"]);
    expect(back.status.note).toBe("mirrored");
  });

  it("records an error without advancing the cursor", () => {
    const s = store();
    const f = enrol(s, ALICE);
    s.saveState(f.id, { leaderNet: 10n, since: 1_700_000_200, boundary: new Set() }, {});
    s.saveError(f.id, "indexer unreachable");
    const after = s.get(f.id)!;
    expect(after.status.error).toBe("indexer unreachable");
    expect(after.since).toBe(1_700_000_200);
    expect(after.leaderNet).toBe("10");
  });

  it("starts empty on a corrupt file rather than refusing to start", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dreamcopy-")), "follows.json");
    writeFileSync(path, "{ not json at all");
    expect(() => new FollowStore(path)).not.toThrow();
    expect(new FollowStore(path).list()).toHaveLength(0);
  });
});
