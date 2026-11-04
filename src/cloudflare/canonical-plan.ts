import type { AssignmentRow, CanonicalStore, PendingProjection } from "../store/core.js";
import type { ProjectionDestinations } from "../notion/projector-core.js";
import type { CompactBinding } from "./compact-journal.js";

type ReadStore = Pick<CanonicalStore, "pendingProjectionsForCourse" | "getAssignment">;
export interface CanonicalObservedCourse {
  courseId: number;
  coursePageId: string;
  courseLabel: string;
  domain: string;
}
export interface CanonicalPlanRequest {
  mode: "dummy";
  binding: CompactBinding;
  destinations: ProjectionDestinations;
  /** Only courses actually observed in this cycle, never all historically active courses. */
  observedCourses: CanonicalObservedCourse[];
  maxOperations: number;
  /** Cycle-owned attempts/deferred rows; skipping is not acknowledgment. */
  attemptedAssignmentIds?: number[];
}
export interface CanonicalPlannedOperation {
  readonly assignmentId: number;
  readonly revision: string;
  readonly targetId: string;
  readonly kind: "write";
  readonly pending: Readonly<PendingProjection>;
  readonly row: Readonly<AssignmentRow>;
  readonly context: Readonly<CanonicalObservedCourse>;
  readonly requestDigest: string;
}
export interface CanonicalPendingPlan {
  readonly mode: "dummy";
  readonly binding: Readonly<CompactBinding>;
  readonly destinations: Readonly<ProjectionDestinations>;
  readonly observedCourses: readonly Readonly<CanonicalObservedCourse>[];
  readonly maxOperations: number;
  readonly attemptedAssignmentIds?: readonly number[];
  readonly operations: readonly CanonicalPlannedOperation[];
  readonly hasMore: boolean;
  readonly planDigest: string;
}
export class CanonicalPlanError extends Error {
  constructor(readonly code: "invalid" | "scope" | "stale" | "unissued") {
    super(`Synthetic canonical plan refused: ${code}`);
    this.name = "CanonicalPlanError";
  }
}
function fail(code: CanonicalPlanError["code"]): never { throw new CanonicalPlanError(code); }
const syntheticId = (v: unknown) => typeof v === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(v);
const numericId = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 990_000_000 && (v as number) <= 990_999_999;

/** Sorted JSON with no coercions, accessors, sparse arrays or lossy numeric values. */
function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (!value || typeof value !== "object") return fail("invalid");
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) fail("invalid");
    return `[${Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !Object.hasOwn(d, "value")) fail("invalid");
      return stable(d.value);
    }).join(",")}]`;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid");
  const keys = Object.keys(value).sort();
  if (Reflect.ownKeys(value).length !== keys.length) fail("invalid");
  return `{${keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(d, "value")) fail("invalid");
    return `${JSON.stringify(key)}:${stable(d.value)}`;
  }).join(",")}}`;
}
function exact(value: object, keys: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail("invalid");
}
function checkedRequest(input: CanonicalPlanRequest): CanonicalPlanRequest {
  // Clone before retaining anything; getters and unsupported JSON fail closed.
  const r = JSON.parse(stable(input)) as CanonicalPlanRequest;
  exact(r, ["mode", "binding", "destinations", "observedCourses", "maxOperations", ...(Object.hasOwn(r, "attemptedAssignmentIds") ? ["attemptedAssignmentIds"] : [])]);
  if (r.mode !== "dummy") fail("scope");
  if (!r.binding || !r.destinations) fail("invalid");
  exact(r.binding, ["accountId", "sourceId", "destinationId"]);
  exact(r.destinations, ["assignmentsDbId", "assignmentsDsId", "coursesDbId", "coursesDsId"]);
  if (![...Object.values(r.binding), ...Object.values(r.destinations)].every(syntheticId)) fail("scope");
  if (!Number.isSafeInteger(r.maxOperations) || r.maxOperations < 1 || r.maxOperations > 20) fail("invalid");
  if (!Array.isArray(r.observedCourses) || r.observedCourses.length > 1000) fail("invalid");
  const ids = new Set<number>();
  for (const c of r.observedCourses) {
    if (!c || typeof c !== "object") fail("invalid");
    exact(c, ["courseId", "coursePageId", "courseLabel", "domain"]);
    if (!numericId(c.courseId) || !syntheticId(c.coursePageId) || c.domain !== "dummy.invalid" ||
        typeof c.courseLabel !== "string" || !/^(?:dummy-|SYNTHETIC_)[A-Za-z0-9_.: -]{1,180}$/.test(c.courseLabel)) fail("scope");
    if (ids.has(c.courseId)) fail("invalid");
    ids.add(c.courseId);
  }
  const attempted = r.attemptedAssignmentIds ?? [];
  if (!Array.isArray(attempted) || attempted.length > 1000 || attempted.some(id => !numericId(id)) || new Set(attempted).size !== attempted.length) fail("invalid");
  r.attemptedAssignmentIds = attempted.sort((a, b) => a - b);
  r.observedCourses.sort((a, b) => a.courseId - b.courseId);
  return r;
}
type Observation = Omit<CanonicalPlannedOperation, "requestDigest">;
function capture(store: ReadStore, request: CanonicalPlanRequest): { observations: Observation[]; hasMore: boolean } {
  const all: { pending: PendingProjection; context: CanonicalObservedCourse }[] = [];
  const attempted = new Set(request.attemptedAssignmentIds);
  for (const id of attempted) {
    const row = store.getAssignment(id);
    if (!row || row.canvas_id !== id || !request.observedCourses.some(c => c.courseId === row.course_id)) fail("scope");
  }
  const ids = new Set<number>();
  for (const context of request.observedCourses) {
    for (const source of store.pendingProjectionsForCourse(context.courseId)) {
      const pending = JSON.parse(stable(source)) as PendingProjection;
      exact(pending, ["assignment_id", "revision", "is_new", "changed_fields", "force_details"]);
      if (!numericId(pending.assignment_id) || ids.has(pending.assignment_id)) fail("scope");
      if (typeof pending.revision !== "string" || !pending.revision.length || pending.revision.length > 180 ||
          ![0, 1].includes(pending.is_new) || ![0, 1].includes(pending.force_details) || typeof pending.changed_fields !== "string") fail("invalid");
      let fields: unknown;
      try { fields = JSON.parse(pending.changed_fields); } catch { fail("invalid"); }
      if (!Array.isArray(fields) || fields.some(x => typeof x !== "string")) fail("invalid");
      ids.add(pending.assignment_id);
      if (!attempted.has(pending.assignment_id)) all.push({ pending, context });
    }
  }
  all.sort((a, b) => a.pending.assignment_id - b.pending.assignment_id);
  return {
    hasMore: all.length > request.maxOperations,
    observations: all.slice(0, request.maxOperations).map(({ pending, context }) => {
      const current = store.getAssignment(pending.assignment_id);
      if (!current) return fail("stale");
      const row = JSON.parse(stable(current)) as AssignmentRow;
      if (row.canvas_id !== pending.assignment_id || row.course_id !== context.courseId) fail("stale");
      // This guard is a fixture fence, not a way to certify arbitrary data as synthetic.
      if (typeof row.name !== "string" || !/^(?:dummy-|SYNTHETIC_)/.test(row.name)) fail("scope");
      return { assignmentId: pending.assignment_id, revision: pending.revision, targetId: `SYNTHETIC_assignment_${pending.assignment_id}`,
        kind: "write", pending, row, context };
    }),
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
const issued = new WeakMap<CanonicalPendingPlan, { request: CanonicalPlanRequest; snapshot: string; observations: Observation[] }>();

/** Read-only dummy planner. It bounds effects (20), NOT scan memory: the current
 * canonical API materializes all pending rows per observed course. It does not
 * admit a run, acknowledge pending rows, infer Do Not Sync, or promise durability.
 * Full current rows, including last_seen_at, are hashed deliberately. Unchanged
 * observations can invalidate plans but never rotate canonical Activity revisions.
 * Rebuild after restart from canonical state under aggregate admission; plans
 * cannot be deserialized/relabelled into authorization for another generation.
 */
export async function planCanonicalPendingBatch(store: ReadStore, input: CanonicalPlanRequest): Promise<CanonicalPendingPlan> {
  const request = checkedRequest(input);
  const captured = capture(store, request);
  const snapshot = stable(captured);
  const operations = await Promise.all(captured.observations.map(async observation => ({ ...observation,
    requestDigest: await digest({ binding: request.binding, destinations: request.destinations, observation }),
  })));
  const content = { ...request, operations, hasMore: captured.hasMore };
  const plan = freeze({ ...content, planDigest: await digest(content) });
  // Hashing awaited: never attach a fresh revision to a stale pre-await payload.
  if (stable(capture(store, request)) !== snapshot) fail("stale");
  issued.set(plan, { request: freeze(request), snapshot, observations: captured.observations });
  return plan;
}

/** Synchronous check immediately after any await and before using a plan.
 * No await is safe between this check and dispatch without checking again.
 * Missing/changed selected pending rows, full row changes, and changed selection
 * all refuse. Provider-side freeze detection must leave canonical pending intact.
 */
export function revalidateCanonicalPendingBatch(store: ReadStore, plan: CanonicalPendingPlan): void {
  const proof = issued.get(plan);
  if (!proof) fail("unissued");
  if (stable(capture(store, proof.request)) !== proof.snapshot) fail("stale");
}

/** Check one issued operation after awaits without invalidating later operations
 * merely because an earlier operation was acknowledged. No implicit completed
 * prefix, replacement row, or caller-supplied revision is accepted.
 *
 * This is NOT acknowledgment permission: canonical completeProjection compares
 * revision only, while unchanged force flags can change within that revision.
 * A caller must serialize observations through check+ack with no await, or use
 * a future full-evidence conditional acknowledgment. Provider freeze outcomes
 * remain pending and may be skipped by the next cycle-owned attempted-ID list.
 */
export function revalidateCanonicalPendingOperation(
  store: ReadStore, plan: CanonicalPendingPlan, operation: CanonicalPlannedOperation,
): void {
  const proof = issued.get(plan);
  if (!proof) fail("unissued");
  const index = plan.operations.indexOf(operation);
  if (index < 0) fail("unissued");
  const original = proof.observations[index]!;
  const pending = store.pendingProjectionsForCourse(original.context.courseId)
    .find(p => p.assignment_id === original.assignmentId);
  const row = store.getAssignment(original.assignmentId);
  if (!pending || !row || stable({ ...original, pending, row }) !== stable(original)) fail("stale");
}
