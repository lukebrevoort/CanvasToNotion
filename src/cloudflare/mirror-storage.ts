import type { DurableSqlStorage } from "./sqlite-storage.js";
import { createMirrorState, validateMirrorState, observeAssignment, acknowledgeRevision, listPending,
  type SyntheticMirrorState, type RevisionToken } from "./mirror-state.js";

export class MirrorStorageError extends Error {
  constructor(readonly code: "uncertain" | "exists" | "uninitialized" | "not-pristine" | "invalid") {
    super(`Synthetic mirror storage refused: ${code}`); this.name = "MirrorStorageError";
  }
}
/** Capture queued inputs without executing accessors or accepting lossy JSON. */
function capture(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth > 32) throw new MirrorStorageError("invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) || Object.getOwnPropertySymbols(value).length) throw new MirrorStorageError("invalid");
  seen.add(value);
  const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((k, i) => k !== String(i)))) throw new MirrorStorageError("invalid");
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!d.enumerable || !Object.hasOwn(d, "value")) throw new MirrorStorageError("invalid");
    Object.defineProperty(out, key, { value: capture(d.value, seen, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value); return out;
}
/** Synthetic-only local atomic mirror. This is NOT an admission gate or a remote
 * receipt verifier. Caller must enforce the aggregate journal/restart gate, then
 * verify/record an exact effect receipt before acknowledging its revision.
 * Separate mirror/journal transactions do not imply atomic aggregate completion.
 */
export class DurableSyntheticMirrorStore {
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage) {}
  private exists(table: string): boolean {
    return this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;
  }
  private read(): SyntheticMirrorState | undefined {
    if (!this.exists("synthetic_mirror_state_v1")) return undefined;
    const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_mirror_state_v1 WHERE slot = 1").toArray();
    return rows.length ? validateMirrorState(JSON.parse(rows[0]!.document)) : undefined;
  }
  private put(state: SyntheticMirrorState): void {
    const encoded = JSON.stringify(validateMirrorState(state));
    if (new TextEncoder().encode(encoded).byteLength > 1_200_000) throw new MirrorStorageError("invalid");
    this.storage.sql.exec("INSERT INTO synthetic_mirror_state_v1 (slot, document) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET document = excluded.document", encoded);
  }
  private mutate<T>(action: () => T): Promise<T> {
    const work = this.tail.then(async () => {
      if (this.failed) throw new MirrorStorageError("uncertain");
      let result: T;
      try { result = this.storage.transactionSync(action); }
      catch (error) { this.failed = true; if (error instanceof MirrorStorageError) throw error; throw new MirrorStorageError("uncertain"); }
      try { await this.storage.sync(); } catch { this.failed = true; throw new MirrorStorageError("uncertain"); }
      return result;
    });
    this.tail = work.then(() => undefined, () => undefined); return work;
  }
  async initialize(input: unknown): Promise<SyntheticMirrorState> {
    const state = createMirrorState(input);
    return this.mutate(() => {
      if (this.read()) throw new MirrorStorageError("exists");
      // Never silently fork an existing interchange mirror into a second store.
      if (this.exists("synthetic_mirror_v1") && this.storage.sql.exec("SELECT slot FROM synthetic_mirror_v1").toArray().length) throw new MirrorStorageError("not-pristine");
      if (this.exists("sync_journal_v1")) {
        const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM sync_journal_v1 WHERE slot = 1").toArray();
        if (rows.length) {
          const j = JSON.parse(rows[0]!.document);
          if (j.schemaVersion !== 1 || !j.binding || Object.entries(state.document.binding).some(([k, v]) => j.binding[k] !== v) || j.generation !== 0 || j.activeRunId !== null || !Array.isArray(j.runs) || j.runs.length) throw new MirrorStorageError("not-pristine");
        }
      }
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_mirror_state_v1 (slot INTEGER PRIMARY KEY CHECK(slot = 1), document TEXT NOT NULL)");
      this.put(state); return state;
    });
  }
  async observeAssignment(input: unknown): Promise<ReturnType<typeof observeAssignment>> {
    const row = capture(input);
    return this.mutate(() => {
      const before = this.read(); if (!before) throw new MirrorStorageError("uninitialized");
      const result = observeAssignment(before, row); this.put(result.state); return result;
    });
  }
  async acknowledgeRevision(input: RevisionToken): Promise<ReturnType<typeof acknowledgeRevision>> {
    const token = capture(input) as RevisionToken;
    return this.mutate(() => {
      const before = this.read(); if (!before) throw new MirrorStorageError("uninitialized");
      const result = acknowledgeRevision(before, token); this.put(result.state); return result;
    });
  }
  async inspect(): Promise<SyntheticMirrorState | undefined> {
    // Serialize observations too. Availability after failure is diagnostic only,
    // never permission to resume effects or assurance of a lost sync outcome.
    const work = this.tail.then(() => this.storage.transactionSync(() => this.read()));
    this.tail = work.then(() => undefined, () => undefined); return work;
  }
  async inspectMetadata(): Promise<{ stateVersion: 1; importId: string; assignmentCount: number; pendingCount: number; dispatchableCount: number; uncertain: boolean } | undefined> {
    const state = await this.inspect();
    return state ? { stateVersion: 1, importId: state.document.importId, assignmentCount: state.document.assignments.length,
      pendingCount: state.revisions.filter(r => r.pending).length, dispatchableCount: listPending(state).length, uncertain: this.failed } : undefined;
  }
}
