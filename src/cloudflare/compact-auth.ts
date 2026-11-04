/** Fresh-only synthetic auth bridge. No V1 migration, recovered admission,
 * generation relabeling or fallback journal exists here. The immutable operation
 * ID/index mapping is checked against the exact admitted compact plan digest.
 */
import { compactPlanDigest, compactTriggerId, type CompactHandle, type CompactOperation, type CompactSyntheticJournal } from "./compact-journal.js";
import type { AuthJournalPort } from "./auth-state.js";
import type { EffectReceipt, OperationIntent, RunHandle } from "./journal.js";

export class CompactAuthError extends Error {
  constructor(readonly code: "invalid" | "mismatch" | "uncertain") {
    super(`Synthetic compact auth: ${code}`); this.name = "CompactAuthError";
  }
}
function fail(code: CompactAuthError["code"]): never { throw new CompactAuthError(code); }
const identifier = (value: unknown): value is string => typeof value === "string" && /^SYNTHETIC_[A-Za-z0-9_.:-]{1,180}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameOperation = (a: CompactOperation, b: CompactOperation) => a.kind === b.kind && a.targetId === b.targetId && a.requestDigest === b.requestDigest;
function checkedHandle(handle: CompactHandle): CompactHandle {
  if (!handle || handle.accountId !== "SYNTHETIC_account" || handle.sourceId !== "SYNTHETIC_canvas" || handle.destinationId !== "SYNTHETIC_notion" ||
      !Number.isSafeInteger(handle.generation) || handle.generation < 0 || handle.generation >= Number.MAX_SAFE_INTEGER ||
      handle.triggerId !== compactTriggerId(handle.generation) || !digest(handle.planDigest)) fail("invalid");
  return { accountId: handle.accountId, sourceId: handle.sourceId, destinationId: handle.destinationId, generation: handle.generation, triggerId: handle.triggerId, planDigest: handle.planDigest };
}
/** Preserve canonical V2 receipts. The sole compatibility rewrite is an auth
 * refresh receipt emitted by the V1 auth kernel; the returned first/replay value
 * is consistently the persisted SYNTHETIC_auth_generation_N receipt. */
function receiptForCompact(value: EffectReceipt, kind: CompactOperation["kind"]): EffectReceipt {
  const receiptId = value?.receiptId;
  if (identifier(receiptId)) return { receiptId };
  const match = typeof receiptId === "string" ? /^dummy-auth-generation-([1-9][0-9]*)$/.exec(receiptId) : null;
  if (kind !== "refresh" || !match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) fail("invalid");
  return { receiptId: `SYNTHETIC_auth_generation_${match[1]}` };
}
export async function createCompactAuthJournal(options: {
  journal: CompactSyntheticJournal;
  handle: CompactHandle;
  operations: OperationIntent[];
}): Promise<{ journal: AuthJournalPort; handle: RunHandle }> {
  const handle = checkedHandle(options.handle), compact = options.journal;
  if (!Array.isArray(options.operations) || options.operations.length > 20) fail("invalid");
  const operationIds = new Set<string>();
  const intents: OperationIntent[] = options.operations.map(value => {
    if (!value || !identifier(value.operationId) || operationIds.has(value.operationId) || !["write", "refresh"].includes(value.kind) || !identifier(value.targetId) || !digest(value.requestDigest)) fail("invalid");
    operationIds.add(value.operationId);
    return { operationId: value.operationId, kind: value.kind, targetId: value.targetId, requestDigest: value.requestDigest };
  });
  const binding = { accountId: handle.accountId, sourceId: handle.sourceId, destinationId: handle.destinationId };
  const plan: CompactOperation[] = intents.map(({ kind, targetId, requestDigest }) => ({ kind, targetId, requestDigest }));
  try {
    await compact.assertOwnedAdmission(handle);
    const planDigest = await compactPlanDigest(binding, handle.generation, plan);
    if (planDigest !== handle.planDigest) fail("mismatch");
    const state = await compact.inspect(), active = state.active;
    if (state.schemaVersion !== 2 || state.generation !== handle.generation || state.binding.accountId !== binding.accountId || state.binding.sourceId !== binding.sourceId || state.binding.destinationId !== binding.destinationId ||
        !active || active.generation !== handle.generation || active.triggerId !== handle.triggerId || active.planDigest !== handle.planDigest || active.phase !== "admitted" ||
        active.plan.length !== plan.length || active.plan.some((value, index) => !sameOperation(value, plan[index]!))) fail("mismatch");
    await compact.assertOwnedAdmission(handle);
  } catch (error) { if (error instanceof CompactAuthError) throw error; throw new CompactAuthError("uncertain"); }
  const mapped: RunHandle = { ...binding, runId: handle.triggerId, generation: handle.generation };
  const validateMapped = (input: RunHandle) => {
    if (!input || input.accountId !== mapped.accountId || input.sourceId !== mapped.sourceId || input.destinationId !== mapped.destinationId || input.runId !== mapped.runId || input.generation !== mapped.generation) fail("mismatch");
  };
  const journal: AuthJournalPort = {
    async assertOwnedAdmission(input) {
      validateMapped(input);
      try { await compact.assertOwnedAdmission(handle); } catch { throw new CompactAuthError("uncertain"); }
    },
    async execute(input, intentInput, effect) {
      validateMapped(input);
      const index = intents.findIndex(value => value.operationId === intentInput?.operationId);
      if (index < 0 || !sameOperation(intents[index]!, intentInput) || typeof effect !== "function") fail("mismatch");
      const expected = intents[index]!;
      try {
        await compact.assertOwnedAdmission(handle);
        return await compact.execute(handle, index, async operation => {
          // Recheck the actual durable operation after the asynchronous admission
          // boundary; never dispatch based on an index alone.
          if (!sameOperation(operation, expected)) fail("mismatch");
          return receiptForCompact(await effect(), expected.kind);
        });
      } catch { throw new CompactAuthError("uncertain"); }
    },
  };
  return { journal: Object.freeze(journal), handle: Object.freeze(mapped) };
}
