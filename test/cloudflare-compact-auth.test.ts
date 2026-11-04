import assert from "node:assert/strict";
import test from "node:test";
import { CompactSyntheticJournal, compactTriggerId, type CompactState, type CompactStorage, type CompactTransaction } from "../src/cloudflare/compact-journal.js";
import { createCompactAuthJournal, CompactAuthError } from "../src/cloudflare/compact-auth.js";
import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord, type AuthStateStorage, type AuthStateTransaction } from "../src/cloudflare/auth-state.js";
import type { OperationIntent } from "../src/cloudflare/journal.js";
class Storage<T> {
  value: T | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  transaction<R>(cb: (tx: { get(): T | undefined; put(value: T): void }) => R): Promise<R> {
    const p = this.tail.then(() => {
      let draft = structuredClone(this.value);
      const result = cb({ get: () => structuredClone(draft), put: value => { draft = structuredClone(value); } });
      this.value = draft; return structuredClone(result);
    }); this.tail = p.catch(() => undefined); return p;
  }
}
class JournalStorage extends Storage<CompactState> implements CompactStorage {
  override transaction<R>(cb: (tx: CompactTransaction) => R) { return super.transaction(cb); }
}
class AuthStorage extends Storage<SyntheticAuthStateRecord> implements AuthStateStorage {
  override transaction<R>(cb: (tx: AuthStateTransaction) => R) { return super.transaction(cb); }
}
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const refresh: OperationIntent = { operationId: "SYNTHETIC_refresh", kind: "refresh", targetId: binding.accountId, requestDigest: "a".repeat(64) };
const write: OperationIntent = { operationId: "SYNTHETIC_projection", kind: "write", targetId: "SYNTHETIC_page", requestDigest: "b".repeat(64) };
async function fixture(operations = [refresh, write]) {
  const storage = new JournalStorage(), compact = new CompactSyntheticJournal(storage);
  await compact.initialize(binding);
  const handle = await compact.admit({ ...binding, expectedGeneration: 0, triggerId: compactTriggerId(0), plan: operations });
  const bridge = await createCompactAuthJournal({ journal: compact, handle, operations });
  return { storage, compact, handle, bridge };
}
const code = (expected: string) => (e: unknown) => e instanceof CompactAuthError && e.code === expected;

test("auth refresh + gated access use exact V2 plan and keep V1 auth behavior structurally compatible", async () => {
  const f = await fixture();
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const auth = new SyntheticAuthStateAdapter({ scope: { syntheticOnly: true, ...binding }, storage: new AuthStorage(), cipher: createSyntheticAesGcmCipher(key) });
  await auth.initialize({ accessToken: 'dummy-old-access', refreshToken: 'dummy-refresh', expiresAt: 1000 });
  assert.deepEqual(await auth.refresh({ journal: f.bridge.journal, handle: f.bridge.handle, expectedGeneration: 0, operationId: refresh.operationId, requestDigest: refresh.requestDigest, exchange: async old => {
    assert.equal(old.refreshToken, 'dummy-refresh'); return { accessToken: 'dummy-new-access', expiresAt: 200000 };
  } }), { receiptId: 'SYNTHETIC_auth_generation_1' });
  assert.deepEqual(await auth.withAccessToken({ journal: f.bridge.journal, handle: f.bridge.handle, expectedGeneration: 1, intent: write, nowMs: () => 100000, minValidityMs: 1000, use: async token => {
    assert.equal(token, 'dummy-new-access'); return { receiptId: 'SYNTHETIC_page_receipt' };
  } }), { receiptId: 'SYNTHETIC_page_receipt' });
  await f.compact.finish(f.handle);
  assert.equal((await f.compact.inspect()).generation, 1);
  assert(!JSON.stringify(f.storage.value).includes('dummy-new-access'));
});

test("narrow refresh receipt mapping returns identical first and replay receipts without redispatch", async () => {
  const f = await fixture([refresh]); let calls = 0;
  const effect = async () => { calls++; return { receiptId: 'dummy-auth-generation-2' }; };
  const first = await f.bridge.journal.execute(f.bridge.handle, refresh, effect);
  const second = await f.bridge.journal.execute(f.bridge.handle, refresh, effect);
  assert.deepEqual(first, { receiptId: 'SYNTHETIC_auth_generation_2' }); assert.deepEqual(first, second); assert.equal(calls, 1);
});

test("binding, generation, trigger and plan digest mismatches cannot create an adapter", async () => {
  const f = await fixture();
  for (const altered of [{ accountId: 'SYNTHETIC_other' }, { generation: 1 }, { triggerId: compactTriggerId(1) }, { planDigest: 'c'.repeat(64) }]) {
    await assert.rejects(createCompactAuthJournal({ journal: f.compact, handle: { ...f.handle, ...altered }, operations: [refresh, write] }));
  }
  await assert.rejects(createCompactAuthJournal({ journal: f.compact, handle: f.handle, operations: [{ ...refresh, requestDigest: 'c'.repeat(64) }, write] }), code('mismatch'));
  await assert.rejects(createCompactAuthJournal({ journal: f.compact, handle: f.handle, operations: [write, refresh] }), code('mismatch'));
  await assert.rejects(createCompactAuthJournal({ journal: f.compact, handle: f.handle, operations: [refresh, { ...write, operationId: refresh.operationId }] }), code('invalid'));
});

test("reconstructed and completed admissions never reopen auth dispatch", async () => {
  const f = await fixture([write]);
  await assert.rejects(createCompactAuthJournal({ journal: new CompactSyntheticJournal(f.storage), handle: f.handle, operations: [write] }), code('uncertain'));
  await f.bridge.journal.execute(f.bridge.handle, write, async () => ({ receiptId: 'SYNTHETIC_done' }));
  await f.compact.finish(f.handle);
  await assert.rejects(f.bridge.journal.assertOwnedAdmission(f.bridge.handle), code('uncertain'));
  await assert.rejects(createCompactAuthJournal({ journal: f.compact, handle: f.handle, operations: [write] }), code('uncertain'));
});

test("mapped V1 handle and every intent field checked before callback", async () => {
  const f = await fixture([write]); let calls = 0; const effect = async () => { calls++; return { receiptId: 'SYNTHETIC_done' }; };
  for (const altered of [{ accountId: 'SYNTHETIC_other' }, { sourceId: 'SYNTHETIC_other' }, { destinationId: 'SYNTHETIC_other' }, { runId: 'SYNTHETIC_other' }, { generation: 1 }]) {
    await assert.rejects(f.bridge.journal.execute({ ...f.bridge.handle, ...altered }, write, effect), code('mismatch'));
  }
  for (const altered of [{ operationId: 'SYNTHETIC_other' }, { kind: 'refresh' as const }, { targetId: 'SYNTHETIC_other' }, { requestDigest: 'c'.repeat(64) }]) {
    await assert.rejects(f.bridge.journal.execute(f.bridge.handle, { ...write, ...altered }, effect), code('mismatch'));
  }
  assert.equal(calls, 0); assert.equal(f.storage.value!.active!.outcomes.length, 0);
});

test("input operation mapping is captured immutably and out-of-order dispatch fails", async () => {
  const operations = structuredClone([refresh, write]); const f = await fixture(operations); let calls = 0;
  operations[0]!.targetId = 'SYNTHETIC_mutated';
  await assert.rejects(f.bridge.journal.execute(f.bridge.handle, write, async () => { calls++; return { receiptId: 'SYNTHETIC_done' }; }), code('uncertain'));
  await f.bridge.journal.execute(f.bridge.handle, refresh, async () => { calls++; return { receiptId: 'dummy-auth-generation-1' }; });
  assert.equal(calls, 1);
});

test("unknown callback response retains V2 uncertainty and blocks all auth operations", async () => {
  const f = await fixture(); let calls = 0;
  await assert.rejects(f.bridge.journal.execute(f.bridge.handle, refresh, async () => { calls++; throw Error('dummy-private-token'); }), code('uncertain'));
  await assert.rejects(f.bridge.journal.assertOwnedAdmission(f.bridge.handle), code('uncertain'));
  await assert.rejects(f.bridge.journal.execute(f.bridge.handle, refresh, async () => { calls++; return { receiptId: 'dummy-auth-generation-1' }; }), code('uncertain'));
  assert.equal(calls, 1); assert.equal(f.storage.value!.active!.phase, 'uncertain');
  assert(!JSON.stringify(f.storage.value).includes('private'));
});

test("refresh receipt rewrite rejects zero, unsafe integer, leading zero and wrong kind", async () => {
  for (const receiptId of ['dummy-auth-generation-0', 'dummy-auth-generation-01', 'dummy-auth-generation-9007199254740992', 'dummy-arbitrary']) {
    const f = await fixture([refresh]);
    await assert.rejects(f.bridge.journal.execute(f.bridge.handle, refresh, async () => ({ receiptId })), code('uncertain'));
  }
  const f = await fixture([write]);
  await assert.rejects(f.bridge.journal.execute(f.bridge.handle, write, async () => ({ receiptId: 'dummy-auth-generation-1' })), code('uncertain'));
});
