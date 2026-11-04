import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthStateError, SyntheticAuthStateAdapter, createSyntheticAesGcmCipher,
  type AuthStateStorage, type AuthStateTransaction, type SyntheticAuthStateRecord,
  type SyntheticAuthCipher, type SyntheticAuthScope,
} from "../src/cloudflare/auth-state.js";
import { SingleWriterJournal, type JournalState, type JournalStorage, type JournalTransaction } from "../src/cloudflare/journal.js";

class Memory<T> {
  value: T | undefined;
  calls = 0;
  failBefore = new Set<number>();
  failAfter = new Set<number>();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<R>(callback: (tx: { get(): T | undefined; put(value: T): void }) => R): Promise<R> {
    const work = this.tail.then(() => {
      const call = ++this.calls;
      let draft = structuredClone(this.value);
      const result = callback({ get: () => structuredClone(draft), put: value => { draft = structuredClone(value); } });
      assert(!(result instanceof Promise));
      if (this.failBefore.delete(call)) throw Error("dummy-private-storage-error");
      this.value = structuredClone(draft);
      if (this.failAfter.delete(call)) throw Error("dummy-private-storage-error");
      return structuredClone(result);
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}
class AuthMemory extends Memory<SyntheticAuthStateRecord> implements AuthStateStorage {
  override transaction<R>(cb: (tx: AuthStateTransaction) => R) { return super.transaction(cb); }
}
class JournalMemory extends Memory<JournalState> implements JournalStorage {
  override transaction<R>(cb: (tx: JournalTransaction) => R) { return super.transaction(cb); }
}
const scope: SyntheticAuthScope = { syntheticOnly: true, accountId: "dummy-account", sourceId: "canvas.invalid", destinationId: "dummy-notion-ds" };
const initial = { accessToken: "dummy-access-0", refreshToken: "dummy-refresh-0", expiresAt: 123456 };
const response = { accessToken: "dummy-access-1", expiresAt: 234567 };
const context = (generation: number) => ({ schemaVersion: 1 as const, binding: scope, generation });
const errorCode = (code: string) => (error: unknown) => error instanceof AuthStateError && error.code === code && !error.message.includes("private");
async function fixture() {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt", "decrypt"]);
  const cipher = createSyntheticAesGcmCipher(key), storage = new AuthMemory(), journalStorage = new JournalMemory();
  const auth = new SyntheticAuthStateAdapter({ scope, storage, cipher });
  await auth.initialize(initial);
  const journal = new SingleWriterJournal(journalStorage);
  await journal.initialize(scope);
  const handle = await journal.admit({ ...scope, runId: "dummy-run", expectedGeneration: 0 });
  const options = { expectedGeneration: 0, journal, handle, operationId: "dummy-refresh", requestDigest: "a".repeat(64), exchange: async () => response };
  return { auth, cipher, storage, journal, journalStorage, options };
}

test("encrypted versioned envelope has no plaintext; inspection exposes metadata only", async () => {
  const f = await fixture();
  assert(!JSON.stringify(f.storage.value).includes(initial.accessToken));
  assert(!JSON.stringify(f.storage.value).includes(initial.refreshToken));
  assert.equal(f.storage.value!.schemaVersion, 1);
  assert.deepEqual(await f.auth.inspect(), { generation: 0, status: "ready", locallyQuarantined: false });
  assert.deepEqual(await f.cipher.open(f.storage.value!.envelope, context(0)), initial);
});

test("refresh preserves omitted refresh token, advances auth generation and journals nonsecret receipt", async () => {
  const f = await fixture(); let calls = 0;
  const receipt = await f.auth.refresh({ ...f.options, exchange: async old => { calls++; assert.deepEqual(old, initial); return response; } });
  assert.equal(calls, 1); assert.equal(receipt.receiptId, "dummy-auth-generation-1");
  assert.deepEqual(await f.cipher.open(f.storage.value!.envelope, context(1)), { ...response, refreshToken: initial.refreshToken });
  assert.equal((await f.journal.inspect()).runs[0]!.operations[0]!.kind, "refresh");
  assert(!JSON.stringify(await f.journal.inspect()).includes(initial.refreshToken));
  await f.journal.finish(f.options.handle);
});

test("explicit refresh rotation is encrypted and persisted", async () => {
  const f = await fixture(); await f.auth.refresh({ ...f.options, exchange: async () => ({ ...response, refreshToken: "dummy-refresh-1" }) });
  assert.equal((await f.cipher.open(f.storage.value!.envelope, context(1))).refreshToken, "dummy-refresh-1");
});

test("stale generation refuses before refresh dispatch", async () => {
  const f = await fixture(); let calls = 0;
  await assert.rejects(f.auth.refresh({ ...f.options, expectedGeneration: 1, exchange: async () => { calls++; return response; } }), errorCode("conflict"));
  assert.equal(calls, 0); assert.equal((await f.journal.inspect()).runs[0]!.operations.length, 0);
});

test("unknown refresh response is sticky across auth reconstruction and sanitized", async () => {
  const f = await fixture(); let calls = 0;
  await assert.rejects(f.auth.refresh({ ...f.options, exchange: async () => { calls++; throw Error("dummy-private-token-body"); } }), errorCode("uncertain"));
  assert.equal(f.storage.value!.status, "uncertain");
  await assert.rejects(f.auth.refresh(f.options), errorCode("uncertain"));
  const reopened = new SyntheticAuthStateAdapter({ scope, storage: f.storage, cipher: f.cipher });
  await assert.rejects(reopened.refresh(f.options), errorCode("uncertain"));
  assert.equal(calls, 1);
  assert(!JSON.stringify(await f.journal.inspect()).includes("private"));
});

for (const afterCommit of [false, true]) test(`credential persistence ${afterCommit ? "lost acknowledgment" : "failure"} never permits another refresh`, async () => {
  const f = await fixture(); let calls = 0;
  // initialize=1, preflight=2, reserve=3, next envelope commit=4.
  (afterCommit ? f.storage.failAfter : f.storage.failBefore).add(4);
  await assert.rejects(f.auth.refresh({ ...f.options, exchange: async () => { calls++; return response; } }), errorCode("uncertain"));
  assert.equal(f.storage.value!.generation, afterCommit ? 1 : 0);
  await assert.rejects(f.auth.refresh({ ...f.options, expectedGeneration: f.storage.value!.generation }), errorCode("uncertain"));
  const reopened = new SyntheticAuthStateAdapter({ scope, storage: f.storage, cipher: f.cipher });
  const recoveredJournal = new SingleWriterJournal(f.journalStorage);
  await assert.rejects(reopened.refresh({ ...f.options, expectedGeneration: f.storage.value!.generation, journal: recoveredJournal, exchange: async () => { calls++; return response; } }));
  assert.equal(calls, 1); assert.equal((await recoveredJournal.inspect()).runs[0]!.status, "uncertain");
});

test("journal acknowledgment failure after credential persistence blocks reconstructed dispatch", async () => {
  const f = await fixture(); f.journalStorage.failBefore.add(4); // initialize, admit, intent, receipt
  await assert.rejects(f.auth.refresh(f.options), errorCode("uncertain"));
  assert.equal(f.storage.value!.status, "ready"); assert.equal(f.storage.value!.generation, 1);
  assert.equal((await f.journal.inspect()).runs[0]!.status, "uncertain");
  const reopened = new SyntheticAuthStateAdapter({ scope, storage: f.storage, cipher: f.cipher });
  let calls = 0;
  await assert.rejects(reopened.refresh({ ...f.options, expectedGeneration: 1, journal: new SingleWriterJournal(f.journalStorage), exchange: async () => { calls++; return response; } }));
  assert.equal(calls, 0);
});

test("concurrent refresh calls dispatch at most once", async () => {
  const f = await fixture(); let release!: () => void, calls = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = f.auth.refresh({ ...f.options, exchange: async () => { calls++; await wait; return response; } });
  await assert.rejects(f.auth.refresh(f.options), errorCode("busy"));
  release(); await first; assert.equal(calls, 1);
});

test("AES-GCM authenticates ciphertext, scope and generation", async () => {
  const f = await fixture(), envelope = f.storage.value!.envelope;
  await assert.rejects(f.cipher.open(envelope, context(1)), errorCode("uncertain"));
  await assert.rejects(f.cipher.open(envelope, { ...context(0), binding: { ...scope, accountId: "dummy-other" } }), errorCode("uncertain"));
  await assert.rejects(f.cipher.open({ ...envelope, ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1) }, context(0)), errorCode("uncertain"));
});

test("decrypt failure quarantines before exchange; invalid response never replaces old envelope", async () => {
  const f = await fixture(); const previous = structuredClone(f.storage.value!.envelope);
  const broken: SyntheticAuthCipher = { ...f.cipher, open: async () => { throw Error("dummy-private-decrypt-error"); } };
  const auth = new SyntheticAuthStateAdapter({ scope, storage: f.storage, cipher: broken }); let calls = 0;
  await assert.rejects(auth.refresh({ ...f.options, exchange: async () => { calls++; return response; } }), errorCode("uncertain"));
  assert.equal(calls, 0); assert.deepEqual(f.storage.value!.envelope, previous);
  const g = await fixture();
  await assert.rejects(g.auth.refresh({ ...g.options, exchange: async () => ({ ...response, refreshToken: "" }) }), errorCode("uncertain"));
  assert.equal(g.storage.value!.generation, 0); assert.equal(g.storage.value!.status, "uncertain");
});

test("real scope/token shapes rejected and initialization cannot overwrite encrypted state", async () => {
  const f = await fixture();
  assert.throws(() => new SyntheticAuthStateAdapter({ scope: { ...scope, syntheticOnly: false } as unknown as SyntheticAuthScope, storage: f.storage, cipher: f.cipher }), errorCode("invalid"));
  assert.throws(() => new SyntheticAuthStateAdapter({ scope: { ...scope, sourceId: "example.instructure.com" }, storage: f.storage, cipher: f.cipher }), errorCode("invalid"));
  await assert.rejects(f.auth.initialize({ ...initial, accessToken: "not-a-dummy-token" }), errorCode("invalid"));
  await assert.rejects(f.auth.initialize(initial), errorCode("conflict"));
});

test("lost journal receipt acknowledgment stays blocked even when both commits are visible", async () => {
  const f = await fixture(); f.journalStorage.failAfter.add(4);
  await assert.rejects(f.auth.refresh(f.options), errorCode("uncertain"));
  assert.equal(f.storage.value!.generation, 1);
  assert.equal((await f.journal.inspect()).runs[0]!.operations[0]!.outcome, "succeeded");
  await assert.rejects(f.auth.refresh({ ...f.options, expectedGeneration: 1 }), errorCode("uncertain"));
  const recovered = new SingleWriterJournal(f.journalStorage);
  const reopened = new SyntheticAuthStateAdapter({ scope, storage: f.storage, cipher: f.cipher });
  let calls = 0;
  await assert.rejects(reopened.refresh({ ...f.options, journal: recovered, expectedGeneration: 1, operationId: "dummy-next-refresh", exchange: async () => { calls++; return response; } }));
  await assert.rejects(recovered.admit({ ...scope, runId: "dummy-new-run", expectedGeneration: 0 }));
  assert.equal(calls, 0);
});

test("auth reservation durability failure dispatches no refresh and retains journal uncertainty", async () => {
  const f = await fixture(); f.storage.failAfter.add(3); let calls = 0;
  await assert.rejects(f.auth.refresh({ ...f.options, exchange: async () => { calls++; return response; } }), errorCode("uncertain"));
  assert.equal(calls, 0); assert.equal(f.storage.value!.status, "uncertain");
  assert.equal((await f.journal.inspect()).runs[0]!.status, "uncertain");
});
