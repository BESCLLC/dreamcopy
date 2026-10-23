// Surviving a restart.
//
// The follow state is the leader's movement SINCE following began. Without it,
// a restarted bot starts that count at zero, computes a target of zero, and
// closes a position it did not open — losing the position and paying the spread
// to do it. That is the single most damaging thing this strategy could do, so
// the state is written after every cycle and restored on startup.
//
// The file is keyed by what the state is only valid for: network, market,
// leader and follow mode. Change any of those and a stale file is ignored
// rather than silently misapplied.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FollowState } from "./copy.js";

const VERSION = 1;

/** What a stored state is valid for. A mismatch means start fresh. */
export interface StateKey {
  network: string;
  symbol: string;
  leader: string;
  followExisting: boolean;
}

export interface StoredState extends StateKey {
  version: number;
  /** Our position when following began: the target is measured from here. */
  anchor: string;
  leaderNet: string;
  since: number;
  boundary: string[];
  updatedAt: string;
}

/**
 * The file name is canonicalised, not just sanitised.
 *
 * `sameKey` compares the leader case-insensitively, so the name has to agree:
 * a checksummed address and its lowercase form are the same follow and must
 * resolve to the same file, or resuming silently starts from scratch.
 */
function fileFor(dir: string, key: StateKey): string {
  const safe = `${key.network}-${key.symbol}-${key.leader}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "_");
  return join(dir, `copytrader-${safe}.json`);
}

function sameKey(a: StateKey, b: StateKey): boolean {
  return (
    a.network === b.network &&
    a.symbol === b.symbol &&
    a.leader.toLowerCase() === b.leader.toLowerCase() &&
    a.followExisting === b.followExisting
  );
}

export interface Restored {
  state: FollowState;
  anchor: bigint;
  updatedAt: string;
}

/**
 * Read the state for this key, or undefined.
 *
 * A file that is unreadable, malformed, from another version or for a different
 * leader is treated as absent. Refusing to start on a corrupt state file would
 * strand the position it exists to protect, so this never throws.
 */
export function loadState(dir: string, key: StateKey): Restored | undefined {
  const path = fileFor(dir, key);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StoredState;
    if (raw.version !== VERSION || !sameKey(raw, key)) return undefined;
    return {
      state: {
        leaderNet: BigInt(raw.leaderNet),
        since: Number(raw.since),
        boundary: new Set(raw.boundary ?? []),
      },
      anchor: BigInt(raw.anchor ?? "0"),
      updatedAt: raw.updatedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Write the state, atomically.
 *
 * A crash during a plain write leaves a truncated file, and a truncated state
 * file is exactly as harmful as no state file. Writing to a temporary name and
 * renaming makes the replacement atomic, so a reader sees the old state or the
 * new one and never half of either.
 */
export function saveState(dir: string, key: StateKey, state: FollowState, anchor: bigint): void {
  const payload: StoredState = {
    version: VERSION,
    ...key,
    anchor: anchor.toString(),
    leaderNet: state.leaderNet.toString(),
    since: state.since,
    boundary: [...state.boundary],
    updatedAt: new Date().toISOString(),
  };
  const path = fileFor(dir, key);
  const tmp = `${path}.tmp`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}
