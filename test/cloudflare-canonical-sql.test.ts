import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createDurableSqlDatabase } from '../src/cloudflare/canonical-sql.js';
import type { DurableSqlStorage } from '../src/cloudflare/sqlite-storage.js';
import { canonicalScenario, inspectCanonical } from './fixtures/canonical-sql-scenario.js';

function fake(rows: Record<string, any>[] = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const storage: Pick<DurableSqlStorage, 'sql' | 'transactionSync'> = {
    sql: { exec(sql, ...values) { calls.push({ sql, values }); return { toArray: () => rows as any, rowsWritten: 99999 }; } },
    transactionSync(callback) { transactions++; return callback(); },
  };
  return { db: createDurableSqlDatabase(storage), calls, transactions: () => transactions };
}
test('named binding lexer preserves literals, quoted identifiers and comments, repeats values in order', () => {
  const { db, calls } = fake([{ result: 1 }]);
  const sql = `SELECT @value, '@ignored; ? : $', "@quoted", \`@backtick\`, [@bracket], 'it''s @literal', @value /* @block; ? */ -- @line; ?\n, @other; -- final`;
  assert.deepEqual(db.prepare(sql).get({ value: 'Dummy', other: null, ignored: true }), { result: 1 });
  assert.deepEqual(calls[0]!.values, ['Dummy', 'Dummy', null]);
  assert.ok(calls[0]!.sql.includes("'it''s @literal'"));
  assert.ok(calls[0]!.sql.includes('/* @block; ? */'));
  assert.deepEqual(db.prepare('SELECT ?, ?, ?').all(1, 'Dummy', null), [{ result: 1 }]);
});
test('unsupported binding and SQL forms fail before executing', () => {
  const { db, calls } = fake();
  for (const sql of ['', '-- comment', "SELECT 'unfinished", 'SELECT /* unfinished', 'SELECT @', 'SELECT ?1', 'SELECT :x', 'SELECT $x', 'SELECT @x, ?', 'SELECT 1; SELECT 2', 'PRAGMA journal_mode=WAL', 'BEGIN', 'COMMIT', 'SAVEPOINT x', 'ATTACH x', 'SELECT 1\0']) assert.throws(() => db.prepare(sql));
  for (const source of ['journal_mode = WAL', 'foreign_keys; DROP TABLE x', 'table_info(x);', 'table_info("x")']) assert.throws(() => db.pragma(source));
  for (const value of [undefined, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 1n, {}, []]) assert.throws(() => db.prepare('SELECT ?').get(value));
  assert.throws(() => db.prepare('SELECT ?').get());
  assert.throws(() => db.prepare('SELECT @x').get({}));
  assert.throws(() => db.prepare('SELECT @x').get(Object.create({ x: 1 })));
  assert.throws(() => db.prepare('SELECT @x').get({ get x() { throw Error('must not access'); } }));
  assert.throws(() => db.exec('SELECT ?'));
  assert.equal(calls.length, 0);
});
test('schema exec and allowlisted pragmas are forwarded while empty get stays undefined', () => {
  const { db, calls } = fake();
  db.exec('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);');
  db.pragma('table_info(a)');
  db.pragma('foreign_keys = ON');
  assert.equal(db.prepare('SELECT id FROM a').get(), undefined);
  assert.equal(calls[0]!.sql, 'CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);');
  assert.equal(calls[1]!.sql, 'PRAGMA table_info(a)');
  assert.equal(calls[2]!.sql, 'PRAGMA foreign_keys = ON');
});
test('metadata uses immediate SQL changes and last rowid rather than billing counters', () => {
  const { db, calls } = fake([{ changes: 1, lastInsertRowid: 7 }]);
  assert.deepEqual(db.prepare('INSERT INTO dummy VALUES (?)').run('Dummy'), { changes: 1, lastInsertRowid: 7 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.sql, 'SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid');
  for (const metadata of [{ changes: -1, lastInsertRowid: 1 }, { changes: 1, lastInsertRowid: 2 ** 53 }, { changes: 1.1, lastInsertRowid: 1 }, { changes: 1, lastInsertRowid: null }]) assert.throws(() => fake([metadata]).db.prepare('DELETE FROM dummy').run(), /unsafe result metadata/);
  assert.throws(() => fake().db.prepare('DELETE FROM dummy').run(), /missing result metadata/);
});
test('transaction callable forwards arguments and nested calls, refusing asynchronous callbacks', () => {
  const { db, transactions } = fake();
  assert.equal(db.transaction((a: number) => db.transaction((b: number) => a + b)(3))(4), 7);
  assert.equal(transactions(), 2);
  assert.throws(() => db.transaction(async () => 1), /synchronous/);
  assert.throws(() => db.transaction(() => Promise.resolve(1))(), /synchronous/);
});
test('actual workerd canonical SQL matches native SQLite and survives restart, including nested rollback', async () => {
  const native = new Database(':memory:');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-canonical-dummy-'));
  const bundle = await build({ entryPoints: ['test/fixtures/cloudflare-canonical-sql-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(name => /node_modules|src\/(?:config|store\/db)/.test(name)), false);
  let outbound = 0;
  const start = () => new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-01', host: '127.0.0.1', port: 0,
    outboundService: () => { outbound++; throw Error('Unexpected outbound in dummy-only test'); },
    durableObjects: { CANONICAL: { className: 'SyntheticCanonicalSqlObject', useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  try {
    const expected = canonicalScenario(native);
    assert.equal(expected.foreignKeyRejected, true);
    assert.deepEqual(expected.nestedRows, [{ id: 1, value: 'Dummy metadata' }, { id: 10, value: 'outer' }, { id: 12, value: 'outer continued' }]);
    assert.deepEqual(expected.canonicalRollback, { assignment: null, snapshots: [], pending: [] });
    assert.equal(expected.updateMetadata.changes, 1);
    assert.equal(expected.absentMetadata.changes, 0);
    const response = await mf.dispatchFetch('http://localhost/run');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), expected);
    await mf.dispose(); mf = start();
    const restored = await mf.dispatchFetch('http://localhost/inspect');
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.deepEqual(await restored.json(), inspectCanonical(native));
    assert.equal(outbound, 0);
  } finally { native.close(); await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
