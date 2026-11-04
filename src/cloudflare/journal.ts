/**
 * Experimental, storage-injected single-writer journal. No provider, network,
 * timer, credential or filesystem code lives here. This is not a production sync.
 *
 * Durable admission and uncertain intents never expire. A process that crashes
 * after admission cannot be replaced by another trigger without separately
 * designed, evidence-based reconciliation. There is deliberately no reset API.
 */
export interface JournalBinding {
  accountId: string;
  sourceId: string;
  destinationId: string;
}

export interface AdmissionRequest extends JournalBinding {
  runId: string;
  expectedGeneration: number;
}

export interface RunHandle extends JournalBinding {
  runId: string;
  generation: number;
}

export interface OperationIntent {
  operationId: string;
  kind: "write" | "refresh";
  targetId: string;
  /** SHA-256 of the exact request, computed by the caller; never the payload. */
  requestDigest: string;
}

export interface EffectReceipt {
  /** Non-secret evidence identifier, not a response body or authentication token. */
  receiptId: string;
}

export type JournalOperation = OperationIntent & (
  | { outcome: "uncertain"; acknowledged: false }
  | { outcome: "succeeded"; acknowledged: true; receipt: EffectReceipt }
);

export interface JournalRun {
  runId: string;
  generation: number;
  status: "admitted" | "uncertain" | "succeeded";
  operations: JournalOperation[];
  completedGeneration?: number;
}

export interface JournalState {
  schemaVersion: 1;
  binding: JournalBinding;
  generation: number;
  activeRunId: string | null;
  /** Prototype ledger: no compaction/pruning policy has been implemented. */
  runs: JournalRun[];
}

export interface JournalTransaction {
  get(): JournalState | undefined;
  put(state: JournalState): void;
}

export interface JournalStorage {
  /**
   * Serializable, all-or-nothing transaction; callback MUST run synchronously.
   * Resolve only after durable commit, never merely after buffering writes.
   * A SQLite Durable Object adapter can use transactionSync then await sync().
   * Throw on commit/durability uncertainty. Never replay external effects here.
   * Serialize transactions through durability resolution: a later callback must
   * not observe tentative writes while an earlier commit is still unresolved.
   * Reads and writes must use isolated values, not shared mutable references.
   */
  transaction<T>(callback: (transaction: JournalTransaction) => T): Promise<T>;
}

export type JournalErrorCode = "invalid" | "uninitialized" | "binding" | "generation"
  | "duplicate" | "busy" | "uncertain" | "conflict" | "inactive";

export class JournalError extends Error {
  constructor(readonly code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
  }
}

function identifier(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value)) {
    throw new JournalError("invalid", "Bounded non-secret identifier required");
  }
}

function generation(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new JournalError("invalid", "Valid nonnegative generation required");
  }
}

function binding(value: JournalBinding): JournalBinding {
  identifier(value.accountId);
  identifier(value.sourceId);
  identifier(value.destinationId);
  return { accountId: value.accountId, sourceId: value.sourceId, destinationId: value.destinationId };
}

function sameBinding(left: JournalBinding, right: JournalBinding): boolean {
  return left.accountId === right.accountId && left.sourceId === right.sourceId && left.destinationId === right.destinationId;
}

function stateFrom(transaction: JournalTransaction): JournalState {
  const state = transaction.get();
  if (!state) throw new JournalError("uninitialized", "Journal binding has not been initialized");
  if (state.schemaVersion !== 1) throw new JournalError("invalid", "Unsupported journal version");
  return structuredClone(state);
}

function assertScope(state: JournalState, scope: JournalBinding, expectedGeneration: number): void {
  if (!sameBinding(state.binding, scope)) throw new JournalError("binding", "Journal account/source/destination mismatch");
  if (state.generation !== expectedGeneration) throw new JournalError("generation", "Stale or unexpected journal generation");
}

function checkedHandle(handle: RunHandle): RunHandle {
  const scope = binding(handle);
  identifier(handle.runId);
  generation(handle.generation);
  return { ...scope, runId: handle.runId, generation: handle.generation };
}

function activeRun(state: JournalState, handle: RunHandle): JournalRun {
  assertScope(state, handle, handle.generation);
  const run = state.runs.find(candidate => candidate.runId === handle.runId);
  if (!run || state.activeRunId !== handle.runId || run.status === "succeeded" || run.generation !== handle.generation) {
    throw new JournalError("inactive", "Run does not own the durable admission");
  }
  return run;
}

/** Only trusted orchestration may call these methods; handles are not auth tokens. */
export class SingleWriterJournal {
  // Persistent active admission is the cross-process fence. Local ownership is
  // an extra guard: recovery may observe receipts, never resume dispatch using
  // a handle reconstructed from storage. Uncertainty also halts this instance.
  private readonly ownedRuns = new Set<string>();
  private quarantined = false;

  constructor(private readonly storage: JournalStorage) {}

  private async transact<T>(callback: (transaction: JournalTransaction) => T): Promise<T> {
    try {
      return await this.storage.transaction(callback);
    } catch (error) {
      // Expected state rejections are not a storage failure. Any other exception
      // leaves this instance quarantined even if a later read observes a commit.
      if (!(error instanceof JournalError)) this.quarantined = true;
      throw error;
    }
  }

  async initialize(expectedBinding: JournalBinding, initialGeneration = 0): Promise<void> {
    const scope = binding(expectedBinding);
    generation(initialGeneration);
    await this.transact(transaction => {
      const existing = transaction.get();
      if (existing) {
        if (existing.schemaVersion !== 1) throw new JournalError("invalid", "Unsupported journal version");
        if (!sameBinding(existing.binding, scope)) throw new JournalError("binding", "Journal binding cannot be replaced");
        return; // Reopening does not clear admission or reset the generation.
      }
      transaction.put({ schemaVersion: 1, binding: scope, generation: initialGeneration, activeRunId: null, runs: [] });
    });
  }

  async inspect(): Promise<JournalState> {
    return this.transact(transaction => stateFrom(transaction));
  }

  async admit(request: AdmissionRequest): Promise<RunHandle> {
    const scope = binding(request);
    identifier(request.runId);
    generation(request.expectedGeneration);
    const runId = request.runId, expectedGeneration = request.expectedGeneration;
    if (this.quarantined) throw new JournalError("uncertain", "This instance is quarantined pending reconciliation");
    const handle = await this.transact(transaction => {
      const state = stateFrom(transaction);
      if (this.quarantined) throw new JournalError("uncertain", "This instance is quarantined pending reconciliation");
      assertScope(state, scope, expectedGeneration);
      if (state.runs.some(run => run.runId === runId)) throw new JournalError("duplicate", "Trigger already has a journal record");
      if (state.activeRunId !== null) {
        const active = state.runs.find(run => run.runId === state.activeRunId);
        throw new JournalError(active?.status === "uncertain" ? "uncertain" : "busy", "A durable admission already blocks this account");
      }
      state.runs.push({ runId, generation: expectedGeneration, status: "admitted", operations: [] });
      state.activeRunId = runId;
      transaction.put(state);
      return { ...scope, runId, generation: expectedGeneration };
    });
    this.ownedRuns.add(runId);
    return handle;
  }

  async execute(handleInput: RunHandle, intentInput: OperationIntent, effect: () => Promise<EffectReceipt>): Promise<EffectReceipt> {
    const handle = checkedHandle(handleInput);
    identifier(intentInput.operationId);
    identifier(intentInput.targetId);
    if (!["write", "refresh"].includes(intentInput.kind) || !/^[a-f0-9]{64}$/.test(intentInput.requestDigest)) {
      throw new JournalError("invalid", "Valid operation kind and exact request digest required");
    }
    const intent: OperationIntent = {
      operationId: intentInput.operationId, kind: intentInput.kind,
      targetId: intentInput.targetId, requestDigest: intentInput.requestDigest,
    };
    let previous: EffectReceipt | undefined;
    try {
      previous = await this.transact(transaction => {
        const state = stateFrom(transaction);
        const run = activeRun(state, handle);
        if (run.status === "uncertain") throw new JournalError("uncertain", "Unresolved operation forbids all replay or takeover");
        const existing = run.operations.find(operation => operation.operationId === intent.operationId);
        if (existing) {
          if (existing.kind !== intent.kind || existing.targetId !== intent.targetId || existing.requestDigest !== intent.requestDigest) {
            throw new JournalError("conflict", "Operation identity cannot refer to a different request");
          }
          if (existing.outcome !== "succeeded") throw new JournalError("uncertain", "Operation outcome is unresolved");
          return structuredClone(existing.receipt);
        }
        if (this.quarantined) throw new JournalError("uncertain", "This instance is quarantined pending reconciliation");
        if (!this.ownedRuns.has(handle.runId)) throw new JournalError("inactive", "Recovered handles cannot resume external effects");
        // Persist uncertainty before the first possible external effect. A crash
        // even before effect() starts is conservatively blocked, not retried.
        run.operations.push({ ...intent, outcome: "uncertain", acknowledged: false });
        run.status = "uncertain";
        transaction.put(state);
        return undefined;
      });
    } catch (error) {
      if (!(error instanceof JournalError)) this.quarantined = true;
      throw error;
    }
    if (previous) return previous;

    // External work is outside the transaction and is invoked at most once.
    // Do not save raw failures or responses, which may contain credentials.
    let receipt: EffectReceipt;
    try {
      const returned = await effect();
      identifier(returned.receiptId);
      receipt = { receiptId: returned.receiptId };
    } catch {
      this.quarantined = true;
      throw new JournalError("uncertain", "External operation did not produce a verified receipt; reconciliation required");
    }
    try {
      await this.transact(transaction => {
        const state = stateFrom(transaction);
        const run = activeRun(state, handle);
        const index = run.operations.findIndex(operation => operation.operationId === intent.operationId);
        const operation = run.operations[index];
        if (run.status !== "uncertain" || !operation || operation.outcome !== "uncertain" ||
            operation.kind !== intent.kind || operation.targetId !== intent.targetId || operation.requestDigest !== intent.requestDigest) {
          throw new JournalError("conflict", "Uncertain operation changed before receipt acknowledgment");
        }
        // Receipt and local acknowledgment commit together, never in two writes.
        run.operations[index] = { ...intent, outcome: "succeeded", acknowledged: true, receipt };
        run.status = "admitted";
        transaction.put(state);
      });
    } catch {
      this.quarantined = true;
      throw new JournalError("uncertain", "Receipt durability is unresolved; observe journal before any further action");
    }
    return structuredClone(receipt);
  }

  async finish(handleInput: RunHandle): Promise<number> {
    const handle = checkedHandle(handleInput);
    return this.transact(transaction => {
      const state = stateFrom(transaction);
      if (!sameBinding(state.binding, handle)) throw new JournalError("binding", "Journal binding mismatch");
      const completed = state.runs.find(run => run.runId === handle.runId);
      if (completed?.status === "succeeded" && completed.generation === handle.generation) return completed.completedGeneration!;
      const run = activeRun(state, handle);
      if (this.quarantined) throw new JournalError("uncertain", "This instance is quarantined pending reconciliation");
      if (run.status === "uncertain" || run.operations.some(operation => operation.outcome !== "succeeded" || !operation.acknowledged)) {
        throw new JournalError("uncertain", "Cannot finish while any operation is unresolved");
      }
      if (!this.ownedRuns.has(handle.runId)) throw new JournalError("inactive", "Recovered admission cannot be released automatically");
      run.status = "succeeded";
      run.completedGeneration = state.generation + 1;
      state.generation++;
      state.activeRunId = null;
      transaction.put(state);
      return state.generation;
    });
  }
}
