import type { JournalBinding } from "./journal.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

export interface ReadinessReference {
  artifactId: string;
  artifactDigest: string;
  cursorId: string;
  journalGeneration: number;
}
export interface CoordinatorReceipt {
  receiptId: string;
  componentReceiptIds: string[];
}
export interface CoordinatorReady {
  reference: ReadinessReference;
  receipt: CoordinatorReceipt;
}
export interface CoordinatorState {
  schemaVersion: 1;
  binding: JournalBinding;
  phase: "empty" | "importing" | "ready" | "running" | "uncertain";
  reference: ReadinessReference | null;
  receipt: CoordinatorReceipt | null;
  operationId: string | null;
  pendingReference: ReadinessReference | null;
  completedOperationIds: string[];
}
/** Must read durable component evidence, including journal generation and absence
 * of active/uncertain work. A status label alone is not proof of readiness. */
export type ReadinessVerifier = (reference: ReadinessReference, receipt: CoordinatorReceipt) => Promise<boolean>;
export class CoordinatorError extends Error {
  constructor(readonly code: "invalid" | "binding" | "not_ready" | "duplicate" | "uncertain" | "capacity") {
    super(`Synthetic coordinator refused: ${code}`);
    this.name = "CoordinatorError";
  }
}
function reject(code: ConstructorParameters<typeof CoordinatorError>[0]): never { throw new CoordinatorError(code); }
const id = (value: unknown): value is string => typeof value === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(value);
function scope(input: JournalBinding): JournalBinding {
  if (!id(input.accountId) || !id(input.sourceId) || !id(input.destinationId)) reject("binding");
  return { accountId: input.accountId, sourceId: input.sourceId, destinationId: input.destinationId };
}
function reference(input: ReadinessReference): ReadinessReference {
  if (!id(input.artifactId) || !id(input.cursorId) || !/^[a-f0-9]{64}$/.test(input.artifactDigest) ||
      !Number.isSafeInteger(input.journalGeneration) || input.journalGeneration < 0 || input.journalGeneration >= Number.MAX_SAFE_INTEGER) reject("invalid");
  return { artifactId: input.artifactId, artifactDigest: input.artifactDigest, cursorId: input.cursorId, journalGeneration: input.journalGeneration };
}
function receipt(input: CoordinatorReceipt): CoordinatorReceipt {
  if (!id(input.receiptId) || !Array.isArray(input.componentReceiptIds) || input.componentReceiptIds.length < 1 ||
      input.componentReceiptIds.length > 20 || input.componentReceiptIds.some(value => !id(value)) ||
      new Set(input.componentReceiptIds).size !== input.componentReceiptIds.length) reject("invalid");
  return { receiptId: input.receiptId, componentReceiptIds: [...input.componentReceiptIds] };
}
const sameScope = (left: JournalBinding, right: JournalBinding) => left.accountId === right.accountId && left.sourceId === right.sourceId && left.destinationId === right.destinationId;
const sameReference = (left: ReadinessReference | null, right: ReadinessReference) => left !== null &&
  left.artifactId === right.artifactId && left.artifactDigest === right.artifactDigest &&
  left.cursorId === right.cursorId && left.journalGeneration === right.journalGeneration;

/**
 * Dummy-only aggregate gate for trusted component orchestration, not a security
 * boundary. All component writes MUST be invoked inside its awaited callbacks.
 * Components retain their own journal/receipt checks; this gate cannot stop code
 * that deliberately calls a raw component or provider outside this coordinator.
 *
 * No reset, timeout takeover, retry, alarm, live transport or credential access.
 * Ready is written only after callbacks and durable evidence verification settle.
 * A lost final ready acknowledgment quarantines this instance. A fresh instance
 * may accept a DISTINCT operation only after revalidating that terminal evidence;
 * importing/running/uncertain states can never be cleared automatically.
 */
export class SyntheticCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private quarantined = false;
  private readonly binding: JournalBinding;

  constructor(private readonly storage: DurableSqlStorage, binding: JournalBinding, private readonly verifyReadiness: ReadinessVerifier) {
    this.binding = scope(binding);
    if (typeof verifyReadiness !== "function") reject("invalid");
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private read(): CoordinatorState | undefined {
    const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_coordinator_v1 WHERE slot=1").toArray();
    if (rows.length > 1) reject("invalid");
    if (!rows.length) return undefined;
    const state = JSON.parse(rows[0]!.document) as CoordinatorState;
    if (state.schemaVersion !== 1 || !sameScope(state.binding, this.binding) ||
        !["empty", "importing", "ready", "running", "uncertain"].includes(state.phase) ||
        !Array.isArray(state.completedOperationIds) || state.completedOperationIds.some(value => !id(value))) reject("binding");
    return state;
  }

  private write(state: CoordinatorState): void {
    const document = JSON.stringify(state);
    if (new TextEncoder().encode(document).byteLength > 65_536) reject("capacity");
    this.storage.sql.exec("INSERT INTO synthetic_coordinator_v1 (slot,document) VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document", document);
  }

  private async commit<T>(change: () => T): Promise<T> {
    if (this.quarantined) reject("uncertain");
    try {
      const result = this.storage.transactionSync(change);
      await this.storage.sync();
      return result;
    } catch (error) {
      if (!(error instanceof CoordinatorError)) this.quarantined = true;
      throw error;
    }
  }

  async initialize(): Promise<void> {
    return this.serial(() => this.commit(() => {
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_coordinator_v1 (slot INTEGER PRIMARY KEY CHECK(slot=1), document TEXT NOT NULL)");
      if (this.read()) return;
      this.write({ schemaVersion: 1, binding: this.binding, phase: "empty", reference: null, receipt: null,
        operationId: null, pendingReference: null, completedOperationIds: [] });
    }));
  }

  async inspect(): Promise<CoordinatorState> {
    return this.serial(async () => {
      const state = this.storage.transactionSync(() => this.read());
      if (!state) reject("not_ready");
      return structuredClone(state);
    });
  }

  async importArtifact(input: { operationId: string; reference: ReadinessReference }, callback: () => Promise<CoordinatorReceipt>): Promise<CoordinatorReady> {
    if (!id(input.operationId)) reject("invalid");
    const operationId = input.operationId, next = reference(input.reference);
    return this.serial(async () => {
      await this.commit(() => {
        const state = this.read();
        if (!state || state.phase !== "empty") reject("not_ready");
        state.phase = "importing";
        state.operationId = operationId;
        state.pendingReference = next;
        this.write(state);
      });
      return this.complete(operationId, next, callback);
    });
  }

  async run(input: { operationId: string; expected: ReadinessReference; next: ReadinessReference }, callback: () => Promise<CoordinatorReceipt>): Promise<CoordinatorReady> {
    if (!id(input.operationId)) reject("invalid");
    const operationId = input.operationId, expected = reference(input.expected), next = reference(input.next);
    if (next.artifactId !== expected.artifactId || next.artifactDigest !== expected.artifactDigest ||
        next.journalGeneration !== expected.journalGeneration + 1) reject("invalid");
    return this.serial(async () => {
      const previous = await this.commit(() => {
        const state = this.read();
        if (!state || state.phase !== "ready" || !state.receipt || !sameReference(state.reference, expected)) reject("not_ready");
        if (state.completedOperationIds.includes(operationId)) reject("duplicate");
        if (state.completedOperationIds.length >= 1_000) reject("capacity");
        const previous = receipt(state.receipt);
        state.phase = "running";
        state.operationId = operationId;
        state.pendingReference = next;
        this.write(state);
        return previous;
      });
      return this.complete(operationId, next, async () => {
        // Durable non-ready admission precedes even the readiness read, so no
        // second component callback can enter while this verification awaits.
        if (await this.verifyReadiness(structuredClone(expected), structuredClone(previous)) !== true) reject("uncertain");
        return callback();
      });
    });
  }

  private async complete(operationId: string, next: ReadinessReference, callback: () => Promise<CoordinatorReceipt>): Promise<CoordinatorReady> {
    try {
      const completed = receipt(await callback());
      if (await this.verifyReadiness(structuredClone(next), structuredClone(completed)) !== true) reject("uncertain");
      await this.commit(() => {
        const state = this.read();
        if (!state || !["importing", "running"].includes(state.phase) || state.operationId !== operationId ||
            !sameReference(state.pendingReference, next)) reject("uncertain");
        state.phase = "ready";
        state.reference = next;
        state.receipt = completed;
        state.completedOperationIds.push(operationId);
        state.operationId = null;
        state.pendingReference = null;
        this.write(state);
      });
      return { reference: structuredClone(next), receipt: structuredClone(completed) };
    } catch {
      // An unavailable storage acknowledgment may leave the prior durable intent
      // or a fully verified terminal ready record. Do not attempt more writes.
      if (!this.quarantined) {
        try {
          await this.commit(() => {
            const state = this.read();
            if (!state || state.operationId !== operationId || !["importing", "running"].includes(state.phase)) reject("uncertain");
            state.phase = "uncertain";
            this.write(state);
          });
        } catch { /* Existing non-ready state remains the durable fence. */ }
      }
      this.quarantined = true;
      throw new CoordinatorError("uncertain");
    }
  }
}
