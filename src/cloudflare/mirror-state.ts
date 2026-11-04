import { validateSyntheticMirrorImport, type SyntheticMirrorDocument } from "./mirror-import.js";

type Assignment = SyntheticMirrorDocument["assignments"][number];
export interface RevisionToken { importId: string; assignmentId: number; revision: number }
export interface PendingMirrorRevision extends RevisionToken { identity: string; assignment: Assignment }
export interface SyntheticMirrorState {
  stateVersion: 1;
  document: SyntheticMirrorDocument;
  revisions: { assignmentId: number; revision: number; pending: boolean }[];
}
export class MirrorStateError extends Error {
  constructor() { super("Invalid synthetic mirror state transition"); this.name = "MirrorStateError"; }
}
function fail(): never { throw new MirrorStateError(); }
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(k => !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k]!, "value"))) fail();
}
/** Validate on every boundary, including a state restored from storage. */
export function validateMirrorState(input: unknown): SyntheticMirrorState {
  exact(input, ["stateVersion", "document", "revisions"]);
  if (input.stateVersion !== 1 || !Array.isArray(input.revisions)) fail();
  const document = validateSyntheticMirrorImport(input.document);
  // Array descriptors are checked before reading entries (no accessors/sparse arrays).
  if (Reflect.ownKeys(input.revisions).length !== input.revisions.length + 1) fail();
  const revisions: SyntheticMirrorState["revisions"] = [];
  const ids = new Set(document.assignments.map(a => a.canvas_id));
  for (let i = 0; i < input.revisions.length; i++) {
    const d = Object.getOwnPropertyDescriptor(input.revisions, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, "value")) fail();
    const r: unknown = d.value;
    exact(r, ["assignmentId", "revision", "pending"]);
    if (!ids.delete(r.assignmentId as number) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || typeof r.pending !== "boolean" || (r.pending && r.revision === 0)) fail();
    revisions.push({ assignmentId: r.assignmentId as number, revision: r.revision as number, pending: r.pending });
  }
  if (ids.size) fail();
  return { stateVersion: 1, document, revisions };
}
export function createMirrorState(input: unknown): SyntheticMirrorState {
  const document = validateSyntheticMirrorImport(input);
  return { stateVersion: 1, document, revisions: document.assignments.map(a => ({ assignmentId: a.canvas_id as number, revision: 0, pending: false })) };
}
const frozen = (s: SyntheticMirrorState, id: number) => s.document.protectedPages.some(p => p.assignmentId === id && p.doNotSync);
function pending(s: SyntheticMirrorState, id: number): PendingMirrorRevision | undefined {
  const r = s.revisions.find(r => r.assignmentId === id);
  if (!r?.pending || frozen(s, id)) return undefined;
  return { importId: s.document.importId, assignmentId: id, revision: r.revision,
    identity: `${s.document.importId}:${id}:${r.revision}`, assignment: { ...s.document.assignments.find(a => a.canvas_id === id)! } };
}
export function listPending(input: SyntheticMirrorState): PendingMirrorRevision[] {
  const s = validateMirrorState(input);
  return s.revisions.flatMap(r => { const p = pending(s, r.assignmentId); return p ? [p] : []; });
}
function equal(a: Assignment, b: Assignment): boolean {
  // Canonical rows contain only validated scalar values; insertion order is irrelevant.
  const keys = Object.keys(a).sort();
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && a[k] === b[k]);
}
/** Pure candidate transition, NOT a durable write or a source watermark advance.
 * Callers must atomically persist this entire state before dispatching any effect.
 * Imported snapshots/watermark and protected Notion fields are never changed.
 * DoNotSync freezes the canonical row too; no implicit unfreeze/reconciliation.
 */
export function observeAssignment(input: SyntheticMirrorState, observation: unknown): {
  state: SyntheticMirrorState; status: "queued" | "unchanged" | "frozen"; pending?: PendingMirrorRevision;
} {
  const state = validateMirrorState(input);
  // Reuse the strict synthetic row validator, including scope/course references.
  const probe = validateSyntheticMirrorImport({ ...state.document, assignments: [observation], snapshots: [], protectedPages: [] });
  const row = probe.assignments[0]!;
  const id = row.canvas_id as number;
  if (frozen(state, id)) return { state, status: "frozen" };
  const index = state.document.assignments.findIndex(a => a.canvas_id === id);
  if (index >= 0 && equal(state.document.assignments[index]!, row)) return { state, status: "unchanged", pending: pending(state, id) };
  let revision = state.revisions.find(r => r.assignmentId === id);
  if (revision?.revision === Number.MAX_SAFE_INTEGER) fail();
  if (!revision) { revision = { assignmentId: id, revision: 0, pending: false }; state.revisions.push(revision); }
  revision.revision++; revision.pending = true;
  if (index < 0) state.document.assignments.push(row); else state.document.assignments[index] = row;
  // Enforce aggregate limits after adding a new assignment.
  validateMirrorState(state);
  return { state, status: "queued", pending: pending(state, id) };
}
/** Acknowledgment is supplied by a caller that has verified its exact projection.
 * No claim of remote verification, receipts, persistence or journal completion.
 */
export function acknowledgeRevision(input: SyntheticMirrorState, token: RevisionToken): {
  state: SyntheticMirrorState; status: "acknowledged" | "stale" | "frozen";
} {
  const state = validateMirrorState(input);
  exact(token, ["importId", "assignmentId", "revision"]);
  if (typeof token.importId !== "string" || !Number.isSafeInteger(token.assignmentId) || !Number.isSafeInteger(token.revision) || token.revision < 1) fail();
  if (token.importId !== state.document.importId) return { state, status: "stale" };
  if (frozen(state, token.assignmentId)) return { state, status: "frozen" };
  const r = state.revisions.find(r => r.assignmentId === token.assignmentId);
  if (!r?.pending || r.revision !== token.revision) return { state, status: "stale" };
  r.pending = false;
  return { state, status: "acknowledged" };
}
