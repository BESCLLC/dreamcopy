// Copy-trading engine.
//
// Everything here is pure or read-only: it reconstructs what traders have done
// from indexer fills and works out what a follower's position should be. It
// places no orders and holds no keys, so the CLI strategy and the hosted
// service can share one implementation of the maths that matters.

export {
  HIDEKI_INDEXER,
  IndexerError,
  fetchAccountFills,
  fetchMarketFacts,
  fetchPerpMarkets,
  fetchRecentFills,
  norm,
  type Fill,
  type MarketFacts,
} from "./indexer.js";

export {
  alignToLot,
  buildLeaderboard,
  clampToNotional,
  ingest,
  netPosition,
  replay,
  signedQty,
  type FollowState,
  type LeaderboardOptions,
  type Replay,
} from "./copy.js";

export { mirrorTarget, scaleBy, type MirrorPlan, type MirrorPolicy } from "./mirror.js";
