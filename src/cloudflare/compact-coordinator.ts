import { compactPlanDigest, compactTriggerId, type CompactBinding, type CompactOperation, type CompactTerminal } from "./compact-journal.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

export interface CompactReadinessReference {
  artifactId: string;
  artifactDigest: string;
  cursorId: string;
  journalGeneration: number;
  journalRootDigest: string;
}
export interface CompactReady {
  reference: CompactReadinessReference;
  terminal: CompactTerminal | null;
  receiptId: string;
}
export interface CompactAdmissionRequest extends CompactBinding {
  expectedGeneration: number;
  triggerId: string;
  plan: CompactOperation[];
}
export interface CompactCoordinatorState {
  schemaVersion: 2;
  binding: CompactBinding;
  generation: number;
  phase: "empty" | "importing" | "ready" | "running" | "uncertain";
  ready: CompactReady | null;
  active: null | {
    kind: "import" | "run";
    triggerId: string;
    expected: CompactReadinessReference | null;
    importReference: CompactReadinessReference | null;
    nextCursorId: string;
    planDigest: string | null;
    plan: CompactOperation[];
  };
}
/** Verify exact durable mirror/cursor state and compact journal generation/root,
 * latest terminal fields and no active work. Hashes are not provider proof. */
export type CompactReadinessVerifier = (ready: CompactReady) => Promise<boolean>;
export class CompactCoordinatorError extends Error {
  constructor(readonly code: "invalid" | "version" | "binding" | "generation" | "not_ready" | "uncertain" | "capacity") {
    super(`Synthetic compact coordinator refused: ${code}`);
    this.name = "CompactCoordinatorError";
  }
}
function fail(code: ConstructorParameters<typeof CompactCoordinatorError>[0]): never { throw new CompactCoordinatorError(code); }
const id = (value: unknown) => typeof value === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameBinding = (a: CompactBinding, b: CompactBinding) => a.accountId === b.accountId && a.sourceId === b.sourceId && a.destinationId === b.destinationId;
function reference(value: CompactReadinessReference): CompactReadinessReference {
  if (!id(value.artifactId) || !id(value.cursorId) || !hash(value.artifactDigest) || !hash(value.journalRootDigest) ||
      !Number.isSafeInteger(value.journalGeneration) || value.journalGeneration < 0) fail("invalid");
  return { artifactId: value.artifactId, artifactDigest: value.artifactDigest, cursorId: value.cursorId,
    journalGeneration: value.journalGeneration, journalRootDigest: value.journalRootDigest };
}
const sameReference = (a: CompactReadinessReference, b: CompactReadinessReference) => JSON.stringify(a) === JSON.stringify(b);
function terminal(value: CompactTerminal): CompactTerminal {
  if (!Number.isSafeInteger(value.generation) || value.generation < 0 || !id(value.triggerId) ||
      !hash(value.planDigest) || !hash(value.receiptDigest) || !hash(value.rootDigest)) fail("invalid");
  return { generation: value.generation, triggerId: value.triggerId, planDigest: value.planDigest,
    receiptDigest: value.receiptDigest, rootDigest: value.rootDigest };
}

/**
 * Fresh-only bounded V2 aggregate gate. Never migrates or prunes V1 evidence.
 * Trigger identity is exactly generation-derived; callers MUST NOT relabel old
 * events with a current generation. Current/unresolved plans remain intact.
 * A terminal checkpoint replaces only this new protocol's prior terminal summary.
 * No historical receipt lookup, reset, takeover, scheduler or provider access.
 *
 * All component work must be awaited inside callbacks. The trusted callback must
 * durably acknowledge exact mirror revisions/cursors BEFORE compact journal finish.
 * Post-terminal verification cannot prove that ordering retroactively. The gate
 * cannot prevent raw component access outside these trusted ports.
 */
export class CompactSyntheticCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private quarantined = false;
  private readonly binding: CompactBinding;
  constructor(private readonly storage: DurableSqlStorage, binding: CompactBinding, private readonly verify: CompactReadinessVerifier) {
    if (!id(binding.accountId) || !id(binding.sourceId) || !id(binding.destinationId) || typeof verify !== "function") fail("binding");
    this.binding = { accountId: binding.accountId, sourceId: binding.sourceId, destinationId: binding.destinationId };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private read(): CompactCoordinatorState | undefined {
    const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_compact_coordinator_v2 WHERE slot=1").toArray();
    if (rows.length > 1) fail("invalid");
    if (!rows.length) return undefined;
    const state = JSON.parse(rows[0]!.document) as CompactCoordinatorState;
    if (state.schemaVersion !== 2) fail("version");
    if (!sameBinding(state.binding, this.binding)) fail("binding");
    if (!Number.isSafeInteger(state.generation) || state.generation < 0 ||
        !["empty", "importing", "ready", "running", "uncertain"].includes(state.phase)) fail("invalid");
    return state;
  }
  private write(state: CompactCoordinatorState): void {
    const document = JSON.stringify(state);
    if (new TextEncoder().encode(document).byteLength > 65_536) fail("capacity");
    this.storage.sql.exec("INSERT INTO synthetic_compact_coordinator_v2(slot,document) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document", document);
  }
  private async commit<T>(change: () => T): Promise<T> {
    if (this.quarantined) fail("uncertain");
    try {
      const result = this.storage.transactionSync(change);
      await this.storage.sync();
      return result;
    } catch (error) {
      if (!(error instanceof CompactCoordinatorError)) this.quarantined = true;
      throw error;
    }
  }
  async initialize(): Promise<void> {
    return this.serial(() => this.commit(() => {
      // Separate object/storage is mandatory; even legacy records with matching
      // dummy identifiers do not authorize a migration or loss of their history.
      if (this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_journal_v1','synthetic_coordinator_v1')").toArray().length) fail("version");
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_compact_coordinator_v2(slot INTEGER PRIMARY KEY CHECK(slot=1),document TEXT NOT NULL)");
      if (this.read()) return;
      this.write({ schemaVersion: 2, binding: this.binding, generation: 0, phase: "empty", ready: null, active: null });
    }));
  }
  async inspect(): Promise<CompactCoordinatorState> {
    return this.serial(async () => {
      const state = this.storage.transactionSync(() => this.read());
      if (!state) fail("not_ready");
      return structuredClone(state);
    });
  }
  async importArtifact(input: CompactReadinessReference, callback: () => Promise<{ receiptId: string }>): Promise<CompactReady> {
    const imported = reference(input);
    if (imported.journalGeneration !== 0 || imported.journalRootDigest !== "0".repeat(64)) fail("generation");
    return this.serial(async () => {
      await this.commit(() => {
        const state = this.read();
        if (!state || state.phase !== "empty" || state.generation !== 0) fail("not_ready");
        state.phase = "importing";
        state.active = { kind: "import", triggerId: "SYNTHETIC_import", expected: null, importReference: imported,
          nextCursorId: imported.cursorId, planDigest: null, plan: [] };
        this.write(state);
      });
      return this.complete("SYNTHETIC_import", async () => {
        const result = await callback();
        if (!id(result.receiptId)) fail("invalid");
        return { reference: imported, terminal: null, receiptId: result.receiptId };
      });
    });
  }
  async run(input: { triggerId: string; expected: CompactReadinessReference; nextCursorId: string; plan: CompactOperation[] },
    callback: (request: CompactAdmissionRequest) => Promise<{ terminal: CompactTerminal; receiptId: string }>): Promise<CompactReady> {
    const expected = reference(input.expected), nextCursorId = input.nextCursorId, triggerId = input.triggerId;
    if (!id(nextCursorId) || triggerId !== compactTriggerId(expected.journalGeneration)) fail("generation");
    const operations = input.plan.map(value => ({ kind: value.kind, targetId: value.targetId, requestDigest: value.requestDigest }));
    const planDigest = await compactPlanDigest(this.binding, expected.journalGeneration, operations);
    return this.serial(async () => {
      const previous = await this.commit(() => {
        const state = this.read();
        if (!state || state.generation !== expected.journalGeneration) fail("generation");
        if (state.phase !== "ready" || !state.ready || !sameReference(state.ready.reference, expected)) fail("not_ready");
        const previous = structuredClone(state.ready);
        state.phase = "running";
        state.active = { kind: "run", triggerId, expected, importReference: null, nextCursorId, planDigest, plan: operations };
        this.write(state);
        return previous;
      });
      return this.complete(triggerId, async () => {
        if (await this.verify(structuredClone(previous)) !== true) fail("uncertain");
        const completed = await callback({ ...this.binding, expectedGeneration: expected.journalGeneration, triggerId, plan: structuredClone(operations) });
        const proof = terminal(completed.terminal);
        if (!id(completed.receiptId) || proof.generation !== expected.journalGeneration || proof.triggerId !== triggerId || proof.planDigest !== planDigest) fail("uncertain");
        return { reference: { ...expected, cursorId: nextCursorId, journalGeneration: expected.journalGeneration + 1, journalRootDigest: proof.rootDigest },
          terminal: proof, receiptId: completed.receiptId };
      });
    });
  }
  private async complete(triggerId: string, work: () => Promise<CompactReady>): Promise<CompactReady> {
    try {
      const ready = await work();
      if (await this.verify(structuredClone(ready)) !== true) fail("uncertain");
      await this.commit(() => {
        const state = this.read();
        if (!state || !["importing", "running"].includes(state.phase) || state.active?.triggerId !== triggerId) fail("uncertain");
        if (ready.reference.journalGeneration !== state.generation + (state.phase === "running" ? 1 : 0)) fail("generation");
        state.phase = "ready";
        state.generation = ready.reference.journalGeneration;
        state.ready = ready;
        state.active = null;
        this.write(state);
      });
      return structuredClone(ready);
    } catch {
      if (!this.quarantined) {
        try {
          await this.commit(() => {
            const state = this.read();
            if (!state || state.active?.triggerId !== triggerId || !["importing", "running"].includes(state.phase)) fail("uncertain");
            state.phase = "uncertain";
            this.write(state);
          });
        } catch { /* Retain prior non-ready admission if durability is unavailable. */ }
      }
      this.quarantined = true;
      throw new CompactCoordinatorError("uncertain");
    }
  }
}
