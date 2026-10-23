// The follow registry: who is copying whom, on what terms, and how far the
// copying has got.
//
// One JSON file, written atomically. That is a deliberate choice rather than a
// placeholder: the keeper and the API run in the same process, so there is one
// writer, and a few hundred follows are nothing to hold in memory. The shape
// below is the whole contract, so moving to SQLite later is a change of
// backend, not of design.
//
// Every follow carries its own copy state. Two people following the same
// trader started at different moments and have different anchors, so a shared
// cursor would give one of them the other's position.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FollowState } from "@dreamdex-bot-kit/copy-core";

const VERSION = 1;

/** The terms of one follow, as the follower set them. */
export interface FollowPolicy {
  ratio: number;
  maxNotional: number;
  minGap: number;
}

/** What the keeper last saw, kept for the dashboard rather than for decisions. */
export interface FollowStatus {
  lastCycleAt?: string;
  /** Signed raw target and position, as decimal strings. */
  target?: string;
  ours?: string;
  leaderNet?: string;
  /** Why nothing happened, or what did. */
  note?: string;
  error?: string;
  /** False until the follower grants the service key on this market's pool. */
  linked?: boolean;
}

export interface Follow extends FollowPolicy {
  id: string;
  /** The follower's DreamDEX account. Orders and margin are theirs. */
  owner: string;
  /** SDK market symbol, e.g. `BTC/USDso:USDso`. */
  market: string;
  /** Human market name for display, e.g. `BTC-PERP`. */
  marketName: string;
  leader: string;
  active: boolean;
  createdAt: string;
  /** Our position when this follow began; the target is measured from here. */
  anchor: string;
  /** Serialized FollowState. */
  leaderNet: string;
  since: number;
  boundary: string[];
  status: FollowStatus;
}

interface FileShape {
  version: number;
  follows: Follow[];
}

export const followId = (owner: string, market: string, leader: string): string =>
  `${owner}:${market}:${leader}`.toLowerCase();

/**
 * The registry.
 *
 * Reads are synchronous against memory; every mutation persists before it
 * returns, so a crash cannot acknowledge a follow it then forgets.
 */
export class FollowStore {
  private follows = new Map<string, Follow>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
      if (raw.version !== VERSION) return;
      for (const f of raw.follows ?? []) this.follows.set(f.id, f);
    } catch {
      // A corrupt registry is not a reason to refuse to start; it is a reason
      // to start empty and say so loudly at the call site.
      this.follows.clear();
    }
  }

  private persist(): void {
    const payload: FileShape = { version: VERSION, follows: [...this.follows.values()] };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  list(): Follow[] {
    return [...this.follows.values()];
  }

  active(): Follow[] {
    return this.list().filter((f) => f.active);
  }

  byOwner(owner: string): Follow[] {
    const key = owner.toLowerCase();
    return this.list().filter((f) => f.owner.toLowerCase() === key);
  }

  get(id: string): Follow | undefined {
    return this.follows.get(id);
  }

  /**
   * Create a follow, or re-activate one that already exists.
   *
   * Following the same leader on the same market twice would mean two targets
   * fighting over one position, so the id is the natural key and a repeat
   * updates the terms instead of adding a second row.
   */
  upsert(input: {
    owner: string;
    market: string;
    marketName: string;
    leader: string;
    policy: FollowPolicy;
    anchor: bigint;
    since: number;
  }): Follow {
    const id = followId(input.owner, input.market, input.leader);
    const existing = this.follows.get(id);
    const follow: Follow = existing
      ? { ...existing, ...input.policy, active: true }
      : {
          id,
          owner: input.owner.toLowerCase(),
          market: input.market,
          marketName: input.marketName,
          leader: input.leader.toLowerCase(),
          ...input.policy,
          active: true,
          createdAt: new Date().toISOString(),
          anchor: input.anchor.toString(),
          leaderNet: "0",
          since: input.since,
          boundary: [],
          status: {},
        };
    this.follows.set(id, follow);
    this.persist();
    return follow;
  }

  /**
   * Stop following.
   *
   * Deactivates rather than deletes: the position the follow opened is still
   * the follower's, and throwing the record away would lose the anchor that
   * explains where it came from.
   */
  deactivate(id: string): Follow | undefined {
    const follow = this.follows.get(id);
    if (!follow) return undefined;
    follow.active = false;
    this.follows.set(id, follow);
    this.persist();
    return follow;
  }

  /** Save the copy cursor after a clean cycle. */
  saveState(id: string, state: FollowState, status: FollowStatus): void {
    const follow = this.follows.get(id);
    if (!follow) return;
    follow.leaderNet = state.leaderNet.toString();
    follow.since = state.since;
    follow.boundary = [...state.boundary];
    follow.status = { ...follow.status, ...status };
    this.follows.set(id, follow);
    this.persist();
  }

  /** Record a failed cycle without advancing the cursor. */
  saveError(id: string, error: string): void {
    const follow = this.follows.get(id);
    if (!follow) return;
    follow.status = { ...follow.status, error, lastCycleAt: new Date().toISOString() };
    this.follows.set(id, follow);
    this.persist();
  }
}

/** The follow's cursor as the engine wants it. */
export function stateOf(follow: Follow): FollowState {
  return {
    leaderNet: BigInt(follow.leaderNet),
    since: follow.since,
    boundary: new Set(follow.boundary),
  };
}
