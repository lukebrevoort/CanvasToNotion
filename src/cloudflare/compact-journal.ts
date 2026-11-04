/** Fresh, opt-in synthetic V2 ledger. NEVER a migration/pruning API for V1.
 * Old generation triggers are permanently fenced by a monotonic counter. Full
 * unresolved evidence is retained. Only fully acknowledged terminal generations
 * fold into an audit commitment; their historical detail is not recoverable here.
 */
export interface CompactBinding { accountId: string; sourceId: string; destinationId: string }
export interface CompactOperation { kind: "write" | "refresh"; targetId: string; requestDigest: string }
export interface CompactReceipt { receiptId: string }
export interface CompactHandle extends CompactBinding { generation: number; triggerId: string; planDigest: string }
export interface CompactTerminal {
  generation: number;
  triggerId: string;
  planDigest: string;
  receiptDigest: string;
  rootDigest: string;
}
export interface CompactActive {
  generation: number;
  triggerId: string;
  planDigest: string;
  phase: "admitted" | "uncertain" | "finalizing";
  plan: CompactOperation[];
  outcomes: ({ status: "uncertain" } | { status: "succeeded"; receipt: CompactReceipt })[];
}
export interface CompactState {
  schemaVersion: 2;
  binding: CompactBinding;
  generation: number;
  rootDigest: string;
  latestTerminal: CompactTerminal | null;
  active: CompactActive | null;
}
export interface CompactTransaction { get(): CompactState | undefined; put(state: CompactState): void }
export interface CompactStorage {
  /** Serializable synchronous callback; resolve only after durable commit.
   * Serialize through durability resolution and isolate returned/written values. */
  transaction<T>(callback: (transaction: CompactTransaction) => T): Promise<T>;
}
export class CompactJournalError extends Error {
  constructor(readonly code: "invalid" | "version" | "binding" | "generation" | "busy" | "inactive" | "uncertain" | "incomplete") {
    super(`Synthetic compact ledger refused: ${code}`);
    this.name = "CompactJournalError";
  }
}
function fail(code: ConstructorParameters<typeof CompactJournalError>[0]): never { throw new CompactJournalError(code); }
const id = (value: unknown) => typeof value === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(value);
const digestPattern = /^[a-f0-9]{64}$/;
const validGeneration = (value: number) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const sameBinding = (a: CompactBinding, b: CompactBinding) => a.accountId === b.accountId && a.sourceId === b.sourceId && a.destinationId === b.destinationId;
function binding(value: CompactBinding): CompactBinding {
  if (!id(value.accountId) || !id(value.sourceId) || !id(value.destinationId)) fail("binding");
  return { accountId: value.accountId, sourceId: value.sourceId, destinationId: value.destinationId };
}
function plan(value: CompactOperation[]): CompactOperation[] {
  if (!Array.isArray(value) || value.length > 20) fail("invalid");
  return value.map(operation => {
    if (!["write", "refresh"].includes(operation.kind) || !id(operation.targetId) || !digestPattern.test(operation.requestDigest)) fail("invalid");
    return { kind: operation.kind, targetId: operation.targetId, requestDigest: operation.requestDigest };
  });
}
async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Canonical plan identity shared by fresh V2 orchestration and the ledger. */
export async function compactPlanDigest(input: CompactBinding, generation: number, operations: CompactOperation[]): Promise<string> {
  const scope = binding(input);
  if (!validGeneration(generation)) fail("generation");
  return sha256({ binding: scope, generation, plan: plan(operations) });
}
export function compactTriggerId(generation: number): string {
  if (!validGeneration(generation)) fail("invalid");
  return `SYNTHETIC_generation_${generation}`;
}
function stateFrom(transaction: CompactTransaction): CompactState {
  const value = transaction.get();
  if (!value || value.schemaVersion !== 2) fail("version");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0 || !digestPattern.test(value.rootDigest)) fail("invalid");
  return structuredClone(value);
}

/** The caller may not relabel an old trigger/request as a new generation.
 * Handles and roots are not credentials or independently verified provider proof.
 * Only trusted offline callbacks are supported; no provider calls exist here.
 */
export class CompactSyntheticJournal {
  private ownedGeneration: number | null = null;
  private quarantined = false;
  constructor(private readonly storage: CompactStorage) {}

  private async transaction<T>(callback: (transaction: CompactTransaction) => T): Promise<T> {
    try { return await this.storage.transaction(callback); }
    catch (error) {
      if (!(error instanceof CompactJournalError)) this.quarantined = true;
      throw error;
    }
  }

  async initialize(input: CompactBinding): Promise<void> {
    const scope = binding(input);
    await this.transaction(transaction => {
      const existing = transaction.get();
      if (existing) {
        if (existing.schemaVersion !== 2) fail("version");
        if (!sameBinding(existing.binding, scope)) fail("binding");
        return;
      }
      transaction.put({ schemaVersion: 2, binding: scope, generation: 0, rootDigest: "0".repeat(64), latestTerminal: null, active: null });
    });
  }

  async inspect(): Promise<CompactState> {
    return this.transaction(stateFrom);
  }

  async admit(input: CompactBinding & { expectedGeneration: number; triggerId: string; plan: CompactOperation[] }): Promise<CompactHandle> {
    const scope = binding(input), generation = input.expectedGeneration;
    if (!validGeneration(generation) || input.triggerId !== compactTriggerId(generation)) fail("generation");
    const operations = plan(input.plan), triggerId = input.triggerId;
    const planDigest = await compactPlanDigest(scope, generation, operations);
    return this.transaction(transaction => {
      if (this.quarantined) fail("uncertain");
      const state = stateFrom(transaction);
      if (!sameBinding(state.binding, scope)) fail("binding");
      if (state.generation !== generation) fail("generation");
      if (state.active) fail(state.active.phase === "admitted" ? "busy" : "uncertain");
      state.active = { generation, triggerId, planDigest, phase: "admitted", plan: operations, outcomes: [] };
      transaction.put(state);
      return { ...scope, generation, triggerId, planDigest };
    }).then(handle => { this.ownedGeneration = handle.generation; return handle; });
  }

  private active(state: CompactState, handle: CompactHandle): CompactActive {
    if (!sameBinding(state.binding, handle)) fail("binding");
    if (state.generation !== handle.generation || handle.triggerId !== compactTriggerId(handle.generation)) fail("generation");
    if (!state.active || state.active.triggerId !== handle.triggerId || state.active.planDigest !== handle.planDigest) fail("inactive");
    return state.active;
  }

  /** Read-only admission assertion for trusted token/transport adapters. */
  async assertOwnedAdmission(handleInput: CompactHandle): Promise<void> {
    const handle = structuredClone(handleInput);
    await this.transaction(transaction => {
      if (this.quarantined) fail("uncertain");
      const active = this.active(stateFrom(transaction), handle);
      if (active.phase !== "admitted") fail("uncertain");
      if (this.ownedGeneration !== handle.generation) fail("inactive");
    });
  }

  async execute(handleInput: CompactHandle, index: number, effect: (operation: Readonly<CompactOperation>) => Promise<CompactReceipt>): Promise<CompactReceipt> {
    const handle = structuredClone(handleInput);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 20) fail("invalid");
    const dispatch = await this.transaction(transaction => {
      const state = stateFrom(transaction), active = this.active(state, handle);
      if (active.phase !== "admitted") fail("uncertain");
      const operation = active.plan[index];
      if (!operation) fail("invalid");
      const previous = active.outcomes[index];
      if (previous?.status === "succeeded") return { previous: structuredClone(previous.receipt) };
      if (this.quarantined) fail("uncertain");
      if (this.ownedGeneration !== handle.generation) fail("inactive");
      if (index !== active.outcomes.length) fail("incomplete");
      active.phase = "uncertain";
      active.outcomes.push({ status: "uncertain" });
      transaction.put(state);
      return { operation: structuredClone(operation) };
    });
    if (dispatch.previous) return dispatch.previous;
    try {
      const returned = await effect(Object.freeze(dispatch.operation!));
      if (!id(returned.receiptId)) fail("invalid");
      const receipt = { receiptId: returned.receiptId };
      await this.transaction(transaction => {
        const state = stateFrom(transaction), active = this.active(state, handle);
        if (active.phase !== "uncertain" || active.outcomes.length !== index + 1 || active.outcomes[index]?.status !== "uncertain") fail("uncertain");
        active.outcomes[index] = { status: "succeeded", receipt };
        active.phase = "admitted";
        transaction.put(state);
      });
      return receipt;
    } catch {
      this.quarantined = true;
      throw new CompactJournalError("uncertain");
    }
  }

  async finish(handleInput: CompactHandle): Promise<CompactTerminal> {
    const handle = structuredClone(handleInput);
    // Persist finalization before hashing: concurrent calls cannot append another
    // effect or fold a different receipt set while asynchronous crypto runs.
    const snapshot = await this.transaction(transaction => {
      if (this.quarantined) fail("uncertain");
      const state = stateFrom(transaction), active = this.active(state, handle);
      if (this.ownedGeneration !== handle.generation) fail("inactive");
      if (active.phase !== "admitted") fail("uncertain");
      if (active.outcomes.length !== active.plan.length || active.outcomes.some(outcome => outcome.status !== "succeeded")) fail("incomplete");
      active.phase = "finalizing";
      transaction.put(state);
      return { rootDigest: state.rootDigest, outcomes: structuredClone(active.outcomes) };
    });
    try {
      const receiptDigest = await sha256(snapshot.outcomes);
      const summary = { generation: handle.generation, triggerId: handle.triggerId, planDigest: handle.planDigest, receiptDigest };
      const terminal: CompactTerminal = { ...summary, rootDigest: await sha256({ schema: "synthetic-compact-v2", previousRoot: snapshot.rootDigest, terminal: summary }) };
      await this.transaction(transaction => {
        const state = stateFrom(transaction), active = this.active(state, handle);
        if (active.phase !== "finalizing" || state.rootDigest !== snapshot.rootDigest) fail("uncertain");
        state.latestTerminal = terminal;
        state.rootDigest = terminal.rootDigest;
        state.generation++;
        state.active = null;
        transaction.put(state);
      });
      this.ownedGeneration = null;
      return structuredClone(terminal);
    } catch {
      this.quarantined = true;
      throw new CompactJournalError("uncertain");
    }
  }
}
