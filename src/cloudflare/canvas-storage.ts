import type { DurableSqlStorage } from "./sqlite-storage.js";
import { readCanvasPage, validateCanvasPageState, type CanvasPageState, type CanvasPageItem } from "./canvas-pages.js";
import { SyntheticJsonTransport } from "./transport.js";

export interface CanvasIngestionState {
  schemaVersion: 1;
  syntheticOnly: true;
  revision: number;
  status: "ready" | "reading";
  page: CanvasPageState;
  items: CanvasPageItem[];
}
export class CanvasStorageError extends Error {
  constructor(readonly code: "invalid" | "exists" | "not-pristine" | "uninitialized" | "stale" | "blocked" | "complete" | "uncertain") {
    super(`Synthetic Canvas storage refused: ${code}`); this.name = "CanvasStorageError";
  }
}
const TABLE = "synthetic_canvas_pages_v1";
// Exact JSON capture without getters, custom prototypes, undefined, or lossy values.
function capture(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth > 32) throw new CanvasStorageError("invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || seen.has(value) || Object.getOwnPropertySymbols(value).length || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new CanvasStorageError("invalid");
  seen.add(value);
  const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((k, i) => k !== String(i)))) throw new CanvasStorageError("invalid");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).sort(([a], [b]) => a.localeCompare(b))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new CanvasStorageError("invalid");
    Object.defineProperty(out, key, { value: capture(descriptor.value, seen, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value); return out;
}
const encode = (value: unknown): string => JSON.stringify(capture(value));
/** Dummy-only endpoint-page persistence, not global sync completion. No journal,
 * projection, or source watermark is advanced here. Each instance serializes
 * admission, sync, request and commit; persisted CAS also prevents overlapping
 * instances from admitting the same page. There is deliberately no reset/retry.
 *
 * A retained reading row means an unresolved read and blocks restart. A retained
 * ready row after final sync receipt loss contains a whole local page commit;
 * inspecting it after restart does not prove the lost receipt or global success.
 */
export class DurableSyntheticCanvasStore {
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage) {}
  private exists(table: string): boolean {
    return this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length > 0;
  }
  private read(): CanvasIngestionState | undefined {
    if (!this.exists(TABLE)) return undefined;
    const rows = this.storage.sql.exec<{ document: string }>(`SELECT document FROM ${TABLE} WHERE slot=1`).toArray();
    if (!rows.length) return undefined;
    const state = JSON.parse(rows[0]!.document) as CanvasIngestionState;
    if (state.schemaVersion !== 1 || state.syntheticOnly !== true || !Number.isSafeInteger(state.revision) || state.revision < 0 || !["ready", "reading"].includes(state.status) || !Array.isArray(state.items)) throw new CanvasStorageError("invalid");
    validateCanvasPageState(state.page);
    if (state.items.length !== state.page.itemsRead || state.items.some((item, i) => item.id !== state.page.seenItemIds[i]) || state.revision !== state.page.pagesRead * 2 + (state.status === "reading" ? 1 : 0)) throw new CanvasStorageError("invalid");
    return state;
  }
  private put(state: CanvasIngestionState): void {
    const document = encode(state);
    if (new TextEncoder().encode(document).byteLength > 5_000_000) throw new CanvasStorageError("invalid");
    this.storage.sql.exec(`INSERT INTO ${TABLE} (slot,document) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document`, document);
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(action); this.tail = work.then(() => undefined, () => undefined); return work;
  }
  private async commit<T>(action: () => T): Promise<T> {
    if (this.failed) throw new CanvasStorageError("uncertain");
    let result: T;
    try { result = this.storage.transactionSync(action); }
    catch (error) {
      if (error instanceof CanvasStorageError) throw error;
      this.failed = true; throw new CanvasStorageError("uncertain");
    }
    try { await this.storage.sync(); }
    catch { this.failed = true; throw new CanvasStorageError("uncertain"); }
    return result;
  }
  async initialize(input: CanvasPageState): Promise<CanvasIngestionState> {
    const page = validateCanvasPageState(capture(input) as CanvasPageState);
    if (page.pagesRead !== 0 || page.itemsRead !== 0) throw new CanvasStorageError("invalid");
    return this.enqueue(() => this.commit(() => {
      if (this.read()) throw new CanvasStorageError("exists");
      // This initializer is an experiment guard, not a security boundary. Known
      // synthetic components may compose in the same DO; no migration occurs.
      const compatible = new Set([TABLE, "synthetic_compact_journal_v2", "synthetic_compact_coordinator_v2", "synthetic_coordinator_v1", "sync_journal_v1", "synthetic_mirror_v1", "synthetic_mirror_state_v1"]);
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray();
      let binding: string | undefined;
      for (const { name } of tables) {
        if (name === TABLE || name.startsWith("sqlite_") || name.startsWith("_cf_")) continue;
        if (!compatible.has(name)) throw new CanvasStorageError("not-pristine");
        for (const row of this.storage.sql.exec<{ document: string }>(`SELECT document FROM ${name}`).toArray()) {
          const existing = JSON.parse(row.document);
          const scope = existing.binding ?? existing.document?.binding;
          if (!scope || !["accountId", "sourceId", "destinationId"].every(k => typeof scope[k] === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(scope[k]))) throw new CanvasStorageError("not-pristine");
          const key = encode({ accountId: scope.accountId, sourceId: scope.sourceId, destinationId: scope.destinationId });
          if (binding !== undefined && binding !== key) throw new CanvasStorageError("not-pristine");
          binding = key;
        }
      }
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (slot INTEGER PRIMARY KEY CHECK(slot=1),document TEXT NOT NULL)`);
      const state: CanvasIngestionState = { schemaVersion: 1, syntheticOnly: true, revision: 0, status: "ready", page, items: [] };
      this.put(state); return structuredClone(state);
    }));
  }
  async ingestPage(expected: CanvasIngestionState, transport: SyntheticJsonTransport): Promise<CanvasIngestionState> {
    const expectedDocument = encode(expected);
    if (!(transport instanceof SyntheticJsonTransport)) throw new CanvasStorageError("invalid");
    return this.enqueue(async () => {
      const admitted = await this.commit(() => {
        const before = this.read(); if (!before) throw new CanvasStorageError("uninitialized");
        if (before.status !== "ready") throw new CanvasStorageError("blocked");
        if (encode(before) !== expectedDocument) throw new CanvasStorageError("stale");
        if (before.page.nextUrl === null) throw new CanvasStorageError("complete");
        const reading: CanvasIngestionState = { ...before, revision: before.revision + 1, status: "reading" };
        this.put(reading); return reading;
      });
      // Any read/validation failure leaves the durable non-ready admission intact.
      const candidate = await readCanvasPage(admitted.page, transport);
      return this.commit(() => {
        const before = this.read();
        if (!before || encode(before) !== encode(admitted)) throw new CanvasStorageError("stale");
        const ready: CanvasIngestionState = { ...admitted, revision: admitted.revision + 1, status: "ready", page: candidate.state, items: [...admitted.items, ...candidate.items] };
        this.put(ready); return structuredClone(ready);
      });
    });
  }
  /** Diagnostic observation, including after a failed durability acknowledgment. */
  inspect(): Promise<CanvasIngestionState | undefined> {
    return this.enqueue(async () => this.storage.transactionSync(() => this.read()));
  }
}
