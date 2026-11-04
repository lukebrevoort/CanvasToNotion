import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";
import type { JournalState, JournalTransaction } from "../src/cloudflare/journal.js";

const fixture: JournalState = { schemaVersion: 1, binding: { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_source", destinationId: "SYNTHETIC_destination" }, generation: 0, activeRunId: null, runs: [] };
function setup(sync: () => Promise<void>) {
  const db = new Database(":memory:");
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows as T[] };
    } },
    transactionSync: callback => db.transaction(callback)(),
    sync,
  };
  return { db, adapter: new DurableSqlJournalStorage(storage) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("SQL transactions remain serialized through durable confirmation", async () => {
  let release!: () => void, first = true, secondEntered = false;
  const pendingSync = new Promise<void>(resolve => { release = resolve; });
  const { db, adapter } = setup(() => { if (first) { first = false; return pendingSync; } return Promise.resolve(); });
  try {
    const a = adapter.transaction(tx => tx.put(fixture));
    const b = adapter.transaction(tx => { secondEntered = true; assert.equal(tx.get()?.generation, 0); });
    await tick(); assert.equal(secondEntered, false);
    release(); await Promise.all([a, b]); assert.equal(secondEntered, true);
  } finally { db.close(); }
});

test("failed durability confirmation blocks queued and future transactions", async () => {
  let reject!: () => void, entered = false;
  const { db, adapter } = setup(() => new Promise<void>((_, fail) => { reject = () => fail(new Error("SYNTHETIC disk failure")); }));
  try {
    const a = adapter.transaction(tx => tx.put(fixture));
    const b = adapter.transaction(() => { entered = true; });
    const outcomes = Promise.allSettled([a, b]);
    await tick(); reject();
    assert.deepEqual((await outcomes).map(x => x.status), ["rejected", "rejected"]);
    assert.equal(entered, false);
    await assert.rejects(adapter.transaction(() => {}), /durability is uncertain/);
  } finally { db.close(); }
});

test("async callbacks roll back, and transaction ports expire", async () => {
  const { db, adapter } = setup(() => Promise.resolve());
  try {
    await assert.rejects(adapter.transaction(async tx => { tx.put(fixture); }), /Synchronous/);
    assert.equal(await adapter.transaction(tx => tx.get()), undefined);
    let escaped!: JournalTransaction;
    await adapter.transaction(tx => { escaped = tx; tx.put(fixture); });
    assert.throws(() => escaped.get(), /closed/);
    const snapshot = await adapter.transaction(tx => tx.get()); snapshot!.generation = 99;
    assert.equal((await adapter.transaction(tx => tx.get()))?.generation, 0);
  } finally { db.close(); }
});
