import type { CoordinatorState } from "./coordinator.js";

/** Starting hypotheses to measure, not a free-tier fit or deployment promise. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_CONTINUATION_DELAY_MS = 5_000;

export interface ScheduleSnapshot {
  phase: CoordinatorState["phase"];
  generation: number;
  /** Derived from durable component verification, never a ready label alone. */
  readinessVerified: boolean;
  journalActive: boolean;
  lastPollCompletedAt: number | null;
  checkpoint?: {
    verified: boolean;
    generation: number;
    completedAt: number;
    remaining: boolean;
    completedRunId: string;
  };
}
export interface SchedulePolicy {
  pollIntervalMs: number;
  continuationDelayMs: number;
}
export type ScheduleDecision =
  | { action: "schedule"; work: "poll" | "continue"; at: number; expectedGeneration: number; completedRunId?: string }
  | { action: "hold"; reason: "active-work" }
  | { action: "stop"; reason: "uncertain" | "not-ready" | "unverified" | "stale-checkpoint" | "invalid" };

const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * Pure planning only: no clock reads, alarms, retries, resource changes or effects.
 * The caller must re-read and verify durable coordinator/journal state immediately
 * before admission. An at-least-once alarm delivery is never permission to replay.
 * A running operation owns its own eventual checkpoint; age never grants takeover.
 */
export function decideNextWake(
  snapshot: ScheduleSnapshot,
  nowMs: number,
  policy: SchedulePolicy = { pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, continuationDelayMs: DEFAULT_CONTINUATION_DELAY_MS },
): ScheduleDecision {
  if (!timestamp(nowMs) || !timestamp(snapshot.generation) || snapshot.generation >= Number.MAX_SAFE_INTEGER ||
      typeof snapshot.readinessVerified !== "boolean" || typeof snapshot.journalActive !== "boolean" ||
      !Number.isSafeInteger(policy.pollIntervalMs) || policy.pollIntervalMs < 60_000 || policy.pollIntervalMs > 86_400_000 ||
      !Number.isSafeInteger(policy.continuationDelayMs) || policy.continuationDelayMs < 1_000 || policy.continuationDelayMs > 60_000 ||
      (snapshot.lastPollCompletedAt !== null && (!timestamp(snapshot.lastPollCompletedAt) || snapshot.lastPollCompletedAt > nowMs))) {
    return { action: "stop", reason: "invalid" };
  }
  if (snapshot.phase === "uncertain") return { action: "stop", reason: "uncertain" };
  if (snapshot.phase === "running" || snapshot.phase === "importing" || snapshot.journalActive) {
    return { action: "hold", reason: "active-work" };
  }
  if (snapshot.phase !== "ready") return { action: "stop", reason: "not-ready" };
  if (!snapshot.readinessVerified) return { action: "stop", reason: "unverified" };

  const checkpoint = snapshot.checkpoint;
  if (checkpoint) {
    if (typeof checkpoint.verified !== "boolean" || typeof checkpoint.remaining !== "boolean") return { action: "stop", reason: "invalid" };
    if (!checkpoint.verified) return { action: "stop", reason: "unverified" };
    if (checkpoint.generation !== snapshot.generation) return { action: "stop", reason: "stale-checkpoint" };
    if (!timestamp(checkpoint.completedAt) || checkpoint.completedAt > nowMs ||
        !/^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(checkpoint.completedRunId)) return { action: "stop", reason: "invalid" };
    if (checkpoint.remaining) {
      const at = Math.max(nowMs, checkpoint.completedAt + policy.continuationDelayMs);
      if (!timestamp(at)) return { action: "stop", reason: "invalid" };
      return { action: "schedule", work: "continue", at, expectedGeneration: snapshot.generation, completedRunId: checkpoint.completedRunId };
    }
  }
  // Coalesce missed intervals into one poll, not a burst of catch-up invocations.
  // A completed full-plan checkpoint is also a completed poll cycle.
  const completedAt = Math.max(snapshot.lastPollCompletedAt ?? 0, checkpoint?.completedAt ?? 0);
  const at = snapshot.lastPollCompletedAt === null && !checkpoint
    ? nowMs : Math.max(nowMs, completedAt + policy.pollIntervalMs);
  if (!timestamp(at)) return { action: "stop", reason: "invalid" };
  return { action: "schedule", work: "poll", at, expectedGeneration: snapshot.generation };
}
