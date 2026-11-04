import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLL_INTERVAL_MS, decideNextWake, type ScheduleSnapshot } from "../src/cloudflare/schedule.js";

const now = 2_000_000;
const ready = (overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot => ({
  phase: "ready", generation: 7, readinessVerified: true, journalActive: false,
  lastPollCompletedAt: now - 60_000, ...overrides,
});
const checkpoint = (remaining = true) => ({ verified: true, generation: 7, completedAt: now - 1_000, remaining, completedRunId: "SYNTHETIC_completed_batch" });

test("idle verified ready schedules a 15-minute poll from last completion", () => {
  assert.deepEqual(decideNextWake(ready(), now), { action: "schedule", work: "poll", at: now - 60_000 + DEFAULT_POLL_INTERVAL_MS, expectedGeneration: 7 });
});
test("first poll is due now and missed intervals coalesce into one poll", () => {
  assert.deepEqual(decideNextWake(ready({ lastPollCompletedAt: null }), now), { action: "schedule", work: "poll", at: now, expectedGeneration: 7 });
  assert.deepEqual(decideNextWake(ready({ lastPollCompletedAt: 1 }), now), { action: "schedule", work: "poll", at: now, expectedGeneration: 7 });
});
test("verified terminal partial checkpoint schedules only its continuation", () => {
  assert.deepEqual(decideNextWake(ready({ checkpoint: checkpoint() }), now), {
    action: "schedule", work: "continue", at: now + 4_000, expectedGeneration: 7, completedRunId: "SYNTHETIC_completed_batch",
  });
});
test("overdue continuation is due once now rather than replaying missed wakes", () => {
  assert.equal(decideNextWake(ready({ checkpoint: { ...checkpoint(), completedAt: now - 10_000 } }), now).action, "schedule");
  const decision = decideNextWake(ready({ checkpoint: { ...checkpoint(), completedAt: now - 10_000 } }), now);
  assert.equal(decision.action === "schedule" && decision.at, now);
});
test("fully completed checkpoint returns to polling after the full cycle completion", () => {
  assert.deepEqual(decideNextWake(ready({ checkpoint: checkpoint(false) }), now), {
    action: "schedule", work: "poll", at: now - 1_000 + DEFAULT_POLL_INTERVAL_MS, expectedGeneration: 7,
  });
});
test("uncertain state always stops; active work never gains a timeout takeover", () => {
  assert.deepEqual(decideNextWake(ready({ phase: "uncertain", checkpoint: checkpoint() }), now), { action: "stop", reason: "uncertain" });
  for (const snapshot of [ready({ phase: "running" }), ready({ phase: "importing" }), ready({ journalActive: true })]) {
    assert.deepEqual(decideNextWake(snapshot, now + 86_400_000), { action: "hold", reason: "active-work" });
  }
});
test("empty or unverified readiness cannot schedule effects", () => {
  assert.deepEqual(decideNextWake(ready({ phase: "empty" }), now), { action: "stop", reason: "not-ready" });
  assert.deepEqual(decideNextWake(ready({ readinessVerified: false }), now), { action: "stop", reason: "unverified" });
  assert.deepEqual(decideNextWake(ready({ checkpoint: { ...checkpoint(), verified: false } }), now), { action: "stop", reason: "unverified" });
});
test("stale completed checkpoint is never used with a newer generation", () => {
  assert.deepEqual(decideNextWake(ready({ checkpoint: { ...checkpoint(), generation: 6 } }), now), { action: "stop", reason: "stale-checkpoint" });
});
test("invalid clocks, bounds, future checkpoints and non-synthetic identities fail closed", () => {
  for (const snapshot of [ready({ generation: -1 }), ready({ lastPollCompletedAt: now + 1 }), ready({ checkpoint: { ...checkpoint(), completedAt: now + 1 } }), ready({ checkpoint: { ...checkpoint(), completedRunId: "real-account" } })]) {
    assert.deepEqual(decideNextWake(snapshot, now), { action: "stop", reason: "invalid" });
  }
  for (const policy of [{ pollIntervalMs: 0, continuationDelayMs: 5_000 }, { pollIntervalMs: 900_000, continuationDelayMs: 0 }]) {
    assert.deepEqual(decideNextWake(ready(), now, policy), { action: "stop", reason: "invalid" });
  }
  assert.deepEqual(decideNextWake(ready(), Number.NaN), { action: "stop", reason: "invalid" });
});
test("pure decisions do not mutate their durable evidence snapshot", () => {
  const snapshot = ready({ checkpoint: checkpoint() }), before = structuredClone(snapshot);
  assert.deepEqual(decideNextWake(snapshot, now), decideNextWake(snapshot, now));
  assert.deepEqual(snapshot, before);
});
