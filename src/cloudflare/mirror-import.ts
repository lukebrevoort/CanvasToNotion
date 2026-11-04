import type { JournalBinding } from "./journal.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

export type MirrorJson = null | boolean | number | string | MirrorJson[] | { [key: string]: MirrorJson };
type JsonRow = { [key: string]: MirrorJson };
export interface SyntheticMirrorDocument {
  schemaVersion: 1;
  scope: "synthetic-only";
  importId: string;
  binding: JournalBinding;
  courses: JsonRow[];
  assignments: JsonRow[];
  snapshots: { assignmentId: number; capturedAt: string; data: JsonRow }[];
  watermark: string | null;
  notionState: { assignmentsDbId: string; assignmentsDsId: string; coursesDbId: string; coursesDsId: string };
  protectedPages: { assignmentId: number; pageId: string; hidden: boolean; inProgress: boolean; doNotSync: boolean; notes: MirrorJson[]; activity: MirrorJson[] }[];
  pendingProjections: [];
  unresolvedRuns: [];
}
export class MirrorImportError extends Error {
  constructor(readonly code: "invalid" | "scope" | "unresolved" | "exists" | "uncertain") {
    super(`Synthetic mirror import refused: ${code}`); this.name = "MirrorImportError";
  }
}
function fail(code: ConstructorParameters<typeof MirrorImportError>[0]): never { throw new MirrorImportError(code); }
const scope: JournalBinding = Object.freeze({ accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" });
const syntheticId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 990_000_000 && (v as number) <= 990_999_999;
const dummyName = (v: unknown): v is string => typeof v === "string" && /^(?:dummy-|SYNTHETIC_)[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
const date = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d\d-\d\d(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(v) && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => { if (Object.keys(v).some(k => !expected.includes(k)) || expected.some(k => !Object.hasOwn(v, k))) fail("invalid"); };
const requiredText = (v: unknown) => { if (typeof v !== "string" || !v.trim()) fail("invalid"); };
function json(value: unknown, seen = new Set<unknown>(), depth = 0): void {
  if (depth > 32) fail("invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || Object.getOwnPropertySymbols(value).length) fail("invalid");
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((k, i) => k !== String(i)))) fail("invalid");
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || /^(?:authorization|credentials|access_?token|refresh_?token|client_?secret|password|api_?key)$/i.test(key)) fail("invalid");
    json(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}
const courseFields = "canvas_id name course_code term_id workflow_state start_at end_at first_seen_at last_seen_at active".split(" ");
const assignmentFields = "canvas_id course_id name due_at calendar_due_at unlock_at lock_at points_possible description_html submission_types group_id group_name group_weight is_quiz position updated_at first_seen_at last_seen_at sub_workflow_state sub_score sub_grade sub_submitted_at sub_graded_at sub_attempts sub_late sub_excused sub_missing".split(" ");
const numericFields = new Set("canvas_id course_id term_id group_id points_possible group_weight position sub_score sub_attempts".split(" "));
const flags = new Set("active is_quiz sub_late sub_excused sub_missing".split(" "));
function row(value: unknown, course: boolean): asserts value is JsonRow {
  if (!object(value) || Object.keys(value).some(k => !(course ? courseFields : assignmentFields).includes(k)) || !syntheticId(value.canvas_id)) fail("invalid");
  requiredText(value.name);
  if (!course && !syntheticId(value.course_id)) fail("scope");
  for (const [k, v] of Object.entries(value)) {
    if (v === null) { if (["canvas_id", "course_id", "name"].includes(k)) fail("invalid"); continue; }
    if (numericFields.has(k)) { if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid"); }
    else if (flags.has(k)) { if (v !== 0 && v !== 1) fail("invalid"); }
    else if (typeof v !== "string") fail("invalid");
    if ((k.endsWith("_at") || ["calendar_due_at", "start_at", "end_at"].includes(k)) && !date(v)) fail("invalid");
    if (k === "submission_types") { let parsed: unknown; try { parsed = JSON.parse(v as string); } catch { fail("invalid"); } if (!Array.isArray(parsed) || parsed.some(x => typeof x !== "string")) fail("invalid"); }
  }
}
/** A deliberately synthetic interchange format, not a production migration reader.
 * No file/provider/credential inputs. Unknown fields and unresolved work fail closed.
 * Notes and historical Activity remain opaque JSON; this code does not rewrite them.
 */
export function validateSyntheticMirrorImport(input: unknown): SyntheticMirrorDocument {
  json(input);
  if (!object(input)) fail("invalid");
  keys(input, ["schemaVersion", "scope", "importId", "binding", "courses", "assignments", "snapshots", "watermark", "notionState", "protectedPages", "pendingProjections", "unresolvedRuns"]);
  if (input.schemaVersion !== 1 || input.scope !== "synthetic-only" || !dummyName(input.importId)) fail("scope");
  if (!object(input.binding)) fail("scope"); keys(input.binding, ["accountId", "sourceId", "destinationId"]);
  if (Object.entries(scope).some(([k, v]) => (input.binding as Record<string, unknown>)[k] !== v)) fail("scope");
  for (const k of ["courses", "assignments", "snapshots", "protectedPages", "pendingProjections", "unresolvedRuns"]) if (!Array.isArray(input[k]) || input[k].length > 1000) fail("invalid");
  if ((input.pendingProjections as unknown[]).length || (input.unresolvedRuns as unknown[]).length) fail("unresolved");
  const courseIds = new Set<number>(), assignmentIds = new Set<number>();
  for (const c of input.courses as unknown[]) { row(c, true); if (courseIds.has(c.canvas_id as number)) fail("invalid"); courseIds.add(c.canvas_id as number); }
  for (const a of input.assignments as unknown[]) { row(a, false); if (assignmentIds.has(a.canvas_id as number) || !courseIds.has(a.course_id as number)) fail("invalid"); assignmentIds.add(a.canvas_id as number); }
  for (const snapshot of input.snapshots as unknown[]) {
    if (!object(snapshot)) fail("invalid"); keys(snapshot, ["assignmentId", "capturedAt", "data"]);
    if (!assignmentIds.has(snapshot.assignmentId as number) || !date(snapshot.capturedAt)) fail("invalid");
    row(snapshot.data, false); if (snapshot.data.canvas_id !== snapshot.assignmentId || !courseIds.has(snapshot.data.course_id as number)) fail("invalid");
  }
  if (input.watermark !== null && !date(input.watermark)) fail("invalid");
  if (!object(input.notionState)) fail("invalid"); keys(input.notionState, ["assignmentsDbId", "assignmentsDsId", "coursesDbId", "coursesDsId"]);
  if (Object.values(input.notionState).some(v => !dummyName(v)) || input.notionState.assignmentsDsId !== scope.destinationId) fail("scope");
  const pages = new Set<string>(), mapped = new Set<number>();
  for (const p of input.protectedPages as unknown[]) {
    if (!object(p)) fail("invalid"); keys(p, ["assignmentId", "pageId", "hidden", "inProgress", "doNotSync", "notes", "activity"]);
    if (!assignmentIds.has(p.assignmentId as number) || !dummyName(p.pageId) || pages.has(p.pageId) || mapped.has(p.assignmentId as number) || [p.hidden, p.inProgress, p.doNotSync].some(v => typeof v !== "boolean") || !Array.isArray(p.notes) || !Array.isArray(p.activity)) fail("invalid");
    pages.add(p.pageId); mapped.add(p.assignmentId as number);
  }
  const encoded = JSON.stringify(input);
  if (new TextEncoder().encode(encoded).byteLength > 1_048_576) fail("invalid");
  return JSON.parse(encoded) as SyntheticMirrorDocument;
}

/** Single bounded mirror document. Never modifies the journal or acknowledges work.
 * Local transaction atomicity is not a production cutover or external-writer fence.
 */
export class SyntheticMirrorImporter {
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage) {}
  async importDocument(input: unknown): Promise<{ status: "imported-synthetic"; importId: string; courseCount: number; assignmentCount: number }> {
    // Capture/validate before queuing so callers cannot mutate an admitted input.
    const document = validateSyntheticMirrorImport(input);
    const work = this.tail.then(async () => {
      if (this.failed) fail("uncertain");
      try { this.storage.transactionSync(() => {
        const journalExists = this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_journal_v1'").toArray().length > 0;
        if (journalExists) {
          const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM sync_journal_v1 WHERE slot = 1").toArray();
          if (rows.length) {
            const journal = JSON.parse(rows[0]!.document);
            if (journal.schemaVersion !== 1 || !journal.binding || Object.entries(scope).some(([k, v]) => journal.binding[k] !== v)) fail("scope");
            if (journal.generation !== 0 || journal.activeRunId !== null || !Array.isArray(journal.runs) || journal.runs.length !== 0) fail("unresolved");
          }
        }
        this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_mirror_v1 (slot INTEGER PRIMARY KEY CHECK(slot = 1), document TEXT NOT NULL)");
        if (this.storage.sql.exec("SELECT slot FROM synthetic_mirror_v1 WHERE slot = 1").toArray().length) fail("exists");
        this.storage.sql.exec("INSERT INTO synthetic_mirror_v1 (slot, document) VALUES (1, ?)", JSON.stringify(document));
      }); } catch (error) {
        if (error instanceof MirrorImportError) throw error;
        this.failed = true; fail("uncertain");
      }
      try { await this.storage.sync(); } catch { this.failed = true; fail("uncertain"); }
      return { status: "imported-synthetic" as const, importId: document.importId, courseCount: document.courses.length, assignmentCount: document.assignments.length };
    });
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }
  async inspect(): Promise<SyntheticMirrorDocument | undefined> {
    await this.tail;
    // Read-only observation remains available after uncertain durability, never
    // permission to retry or a claim that the previous commit was acknowledged.
    return this.storage.transactionSync(() => {
      if (!this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'synthetic_mirror_v1'").toArray().length) return undefined;
      const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_mirror_v1 WHERE slot = 1").toArray();
      return rows.length ? validateSyntheticMirrorImport(JSON.parse(rows[0]!.document)) : undefined;
    });
  }
}
