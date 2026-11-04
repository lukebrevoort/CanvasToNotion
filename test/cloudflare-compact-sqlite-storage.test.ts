import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {DurableSqlCompactStorage} from '../src/cloudflare/compact-sqlite-storage.js';
import {CompactSyntheticJournal,compactTriggerId} from '../src/cloudflare/compact-journal.js';
import type {DurableSqlStorage} from '../src/cloudflare/sqlite-storage.js';
function fixture(sync:()=>Promise<void>=async()=>{}) {
  const db=new Database(':memory:');
  const storage:DurableSqlStorage={sql:{exec(query,...bindings){const statement=db.prepare(query);const rows=statement.reader?statement.all(...bindings):(statement.run(...bindings),[]);return {toArray:()=>rows as any};}},transactionSync:callback=>db.transaction(callback)(),sync};
  return {db,storage};
}
const binding={accountId:'SYNTHETIC_account',sourceId:'SYNTHETIC_canvas',destinationId:'SYNTHETIC_notion'};
test('compact SQLite adapter persists terminal generation across journal reconstruction',async()=>{
  const {db,storage}=fixture();try{
    const journal=new CompactSyntheticJournal(new DurableSqlCompactStorage(storage));await journal.initialize(binding);
    const h=await journal.admit({...binding,expectedGeneration:0,triggerId:compactTriggerId(0),plan:[]});await journal.finish(h);
    const restored=new CompactSyntheticJournal(new DurableSqlCompactStorage(storage));assert.equal((await restored.inspect()).generation,1);
    await assert.rejects(restored.admit({...binding,expectedGeneration:0,triggerId:compactTriggerId(0),plan:[]}));
  }finally{db.close();}
});
test('compact SQLite adapter refuses V1 history without modifying it',async()=>{
  const {db,storage}=fixture();try{
    db.exec('CREATE TABLE sync_journal_v1(slot INTEGER PRIMARY KEY,document TEXT NOT NULL)');db.prepare('INSERT INTO sync_journal_v1 VALUES(1,?)').run('SYNTHETIC_legacy');
    await assert.rejects(new CompactSyntheticJournal(new DurableSqlCompactStorage(storage)).initialize(binding),/Fresh compact storage/);
    assert.equal((db.prepare('SELECT document FROM sync_journal_v1').get() as any).document,'SYNTHETIC_legacy');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='synthetic_compact_journal_v2'").get(),undefined);
  }finally{db.close();}
});
test('lost compact storage durability blocks queued and future operations',async()=>{
  let calls=0;const {db,storage}=fixture(async()=>{calls++;throw Error('Synthetic lost durability');});try{
    const adapter=new DurableSqlCompactStorage(storage);const journal=new CompactSyntheticJournal(adapter);
    await assert.rejects(journal.initialize(binding));await assert.rejects(journal.inspect());assert.equal(calls,1);
  }finally{db.close();}
});
