import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createStore, type AssignmentInput } from "../src/store/core.js";
import { planCanonicalPendingBatch, type CanonicalPlanRequest } from "../src/cloudflare/canonical-plan.js";
import { SyntheticCanonicalProjector, type CanonicalProjectionRequest } from "../src/cloudflare/canonical-project.js";
import { CompactSyntheticJournal, compactTriggerId } from "../src/cloudflare/compact-journal.js";
import { DurableSqlCompactStorage } from "../src/cloudflare/compact-sqlite-storage.js";
import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from "../src/cloudflare/auth-state.js";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";
import { SyntheticSqlPort } from "./fixtures/synthetic-sql-port.js";
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const cid = 990000001, aid = 990000100, now = "2026-01-01T00:00:00.000Z";
const assignment = (id: number): AssignmentInput => ({ canvas_id: id, course_id: cid, name: "dummy-assignment", due_at: null, calendar_due_at: null, unlock_at: null, lock_at: null, points_possible: 10, description_html: null, submission_types: "[]", group_id: null, group_name: null, group_weight: null, is_quiz: false, position: null, updated_at: null, sub_workflow_state: null, sub_score: null, sub_grade: null, sub_submitted_at: null, sub_graded_at: null, sub_attempts: null, sub_late: null, sub_excused: false, sub_missing: true });
const planRequest = (attemptedAssignmentIds: number[] = []): CanonicalPlanRequest => ({ mode: "dummy", binding,
  destinations: { assignmentsDbId: "SYNTHETIC_assignments_db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "SYNTHETIC_courses_db", coursesDsId: "SYNTHETIC_courses_ds" },
  observedCourses: [{ courseId: cid, coursePageId: "SYNTHETIC_course_page", courseLabel: "dummy-course", domain: "dummy.invalid" }], maxOperations: 20, attemptedAssignmentIds });
async function fixture(count = 1) {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
  let uuid = 0, syncFail = () => false;
  const deps = { now: () => now, randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12,"0")}` };
  const store = createStore(db, deps); store.upsertCourse({ id: cid, name: "dummy-course" });
  for (let i = 0; i < count; i++) store.upsertAssignment(assignment(aid + i));
  // A verified existing-page fixture isolates properties-only projections.
  db.exec("UPDATE pending_assignment_projections SET is_new=0, changed_fields='[]', force_details=0");
  const runId = store.startSyncRun();
  const cycle = { cycleId: "SYNTHETIC_cycle", revision: 1, runId };
  db.exec("CREATE TABLE synthetic_canonical_cycle_v1(slot INTEGER PRIMARY KEY,document TEXT)");
  db.prepare("INSERT INTO synthetic_canonical_cycle_v1 VALUES(1,?)").run(JSON.stringify({ schemaVersion:1,syntheticOnly:true,...cycle,startedAt:now,status:"source_complete",phase:"source_complete",courses:[{id:cid,timeZone:null}] }));
  const storage: DurableSqlStorage = {
    sql: { exec(query, ...values) {
      if (query.includes("CREATE TABLE IF NOT EXISTS meta")) { db.exec(query); return { toArray: () => [] }; }
      const statement = db.prepare(query); const rows = statement.reader ? statement.all(...values) : (statement.run(...values), []);
      return { toArray: () => rows as any };
    } }, transactionSync: cb => db.transaction(cb)(), sync: async () => { if (syncFail()) throw Error("dummy lost durability"); },
  };
  const journal = new CompactSyntheticJournal(new DurableSqlCompactStorage(storage)); await journal.initialize(binding);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt", "decrypt"]);
  const auth = new SyntheticAuthStateAdapter({ scope: { ...binding, syntheticOnly:true }, storage:new SyntheticSqlPort<SyntheticAuthStateRecord>(storage),cipher:createSyntheticAesGcmCipher(key) });
  await auth.initialize({ accessToken:"dummy-access",refreshToken:"dummy-refresh",expiresAt:1_000_000 });
  const frozen = new Set<number>(); const writes: number[] = [], calls: string[] = [];
  const properties = new Map<number, Record<string, any>>();
  const fetchPort: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin,"https://notion.invalid");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push(`${init?.method} ${u.pathname}`);
    if (u.pathname.includes("data_sources")) return Response.json({ results:[{id:`SYNTHETIC_page_${body.filter.number.equals}`}],has_more:false,next_cursor:null });
    const id = Number(u.pathname.split("_").at(-1));
    if (init?.method === "PATCH") { properties.set(id, body.properties); writes.push(id); }
    return Response.json({id:`SYNTHETIC_page_${id}`,properties:{...properties.get(id),"Do Not Sync":{checkbox:frozen.has(id)},Hidden:{checkbox:true},"In Progress":{checkbox:true}}});
  };
  const projector = new SyntheticCanonicalProjector(storage,deps);
  const state = () => { const row = db.prepare("SELECT document FROM synthetic_canonical_projection_v1 WHERE slot=1").get() as any; return JSON.parse(row.document); };
  const request = async (attemptedAssignmentIds: number[] = [], previousTerminal?: any): Promise<CanonicalProjectionRequest> => {
    const plan = await planCanonicalPendingBatch(store,planRequest(attemptedAssignmentIds));
    const generation = (await journal.inspect()).generation;
    const handle = await journal.admit({...binding,expectedGeneration:generation,triggerId:compactTriggerId(generation),plan:plan.operations.map(o=>({kind:o.kind,targetId:o.targetId,requestDigest:o.requestDigest}))});
    return {plan,handle,cycle,journal,auth,authGeneration:0,previousTerminal,nowMs:()=>100_000,minValidityMs:40_000,operationTimeoutMs:30_000,timeoutMs:1000,maxResponseBytes:65536,requestBudget:50,fetch:fetchPort,
      verifyContext: (c,p)=>c.cycleId===cycle.cycleId && Object.entries(binding).every(([k,v])=>p.binding[k as keyof typeof binding]===v),
      verifyResult: async (op,result)=> result.pageId===`SYNTHETIC_page_${op.assignmentId}` && (result.pushed ? properties.get(op.assignmentId)?.AssignmentID.number===op.assignmentId : frozen.has(op.assignmentId)),
    };
  };
  return {db,store,storage,deps,cycle,journal,auth,projector,state,request,frozen,writes,calls,setSyncFailure:(fn:()=>boolean)=>{syncFail=fn;}};
}

test("actual portable properties projection durably acknowledges exact outcome before terminal, without run success",async()=>{
  const f=await fixture(2);try{
    const result=await f.projector.run(await f.request());
    assert.equal(result.state.phase,"terminal");assert.equal(result.state.outcomes.length,2);
    assert.deepEqual(result.state.attemptedAssignmentIds,[aid,aid+1]);assert.deepEqual(f.writes,[aid,aid+1]);
    assert.deepEqual(f.store.pendingProjectionsForCourse(cid),[]);assert.equal(f.store.lastSuccessfulSyncStart(),undefined);
    assert.equal((f.db.prepare("SELECT status FROM sync_runs WHERE id=?").get(f.cycle.runId) as any).status,"running");
    const j=await f.journal.inspect();assert.equal(j.active,null);assert.deepEqual(j.latestTerminal,result.terminal);
    assert(!JSON.stringify(result).includes("dummy-access"));
  }finally{f.db.close();}
});

test("durable frozen attempts allow explicit next batch while preserving all frozen pending",async()=>{
  const f=await fixture(22);try{
    for(let i=0;i<20;i++)f.frozen.add(aid+i);
    const first=await f.projector.run(await f.request());
    assert.equal(first.state.outcomes.every(o=>!o.pushed&&!o.acknowledged),true);assert.equal(f.writes.length,0);
    const second=await f.projector.run(await f.request(first.state.attemptedAssignmentIds,first.terminal));
    assert.deepEqual(f.writes,[aid+20,aid+21]);assert.equal(second.state.attemptedAssignmentIds.length,22);
    assert.deepEqual(second.state.previousTerminal,first.terminal);assert.equal(second.state.outcomes.length,2);
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,20);
  }finally{f.db.close();}
});

test("changed same-revision flags after HTTP verification refuse exact ack and finish",async()=>{
  const f=await fixture();try{
    const r=await f.request();const original=r.plan.operations[0]!.revision;
    r.verifyResult=async()=>{f.store.upsertAssignment(assignment(aid),{forceProjection:true});return true;};
    await assert.rejects(f.projector.run(r),/uncertain/);
    assert.equal(f.store.pendingProjectionsForCourse(cid)[0]!.revision,original);
    assert.equal(f.store.pendingProjectionsForCourse(cid)[0]!.force_details,1);
    assert.equal(f.state().outcomes.length,0);assert.equal((await f.journal.inspect()).active!.phase,"uncertain");
  }finally{f.db.close();}
});

test("outcome write failure rolls back exact pending delete and attempted progress atomically",async()=>{
  const f=await fixture();try{
    const r=await f.request();r.verifyResult=async()=>{
      f.db.exec("CREATE TEMP TRIGGER reject_outcome BEFORE UPDATE ON synthetic_canonical_projection_v1 WHEN json_array_length(json_extract(NEW.document,'$.outcomes')) > 0 BEGIN SELECT RAISE(ABORT,'dummy rollback'); END");return true;
    };
    await assert.rejects(f.projector.run(r));
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,1);assert.deepEqual(f.state().attemptedAssignmentIds,[]);assert.deepEqual(f.state().outcomes,[]);
  }finally{f.db.close();}
});

test("ack commit then lost durability retains outcome and blocks fresh-process replay",async()=>{
  const f=await fixture();try{
    const r=await f.request();r.verifyResult=async()=>{f.setSyncFailure(()=>f.state().outcomes.length===1);return true;};
    await assert.rejects(f.projector.run(r));
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,0);assert.equal(f.state().outcomes.length,1);assert.equal(f.state().phase,"running");
    const count=f.calls.length;f.setSyncFailure(()=>false);
    const restored=new SyntheticCanonicalProjector(f.storage,f.deps);
    const recoveredJournal=new CompactSyntheticJournal(new DurableSqlCompactStorage(f.storage));
    await assert.rejects(restored.run({...r,journal:recoveredJournal}));
    assert.equal(f.calls.length,count);assert.equal((await recoveredJournal.inspect()).active!.phase,"uncertain");
  }finally{f.db.close();}
});

test("source, context and request exhaustion never produce terminal or clear pending",async()=>{
  for(const kind of ["source","context","budget"]){const f=await fixture();try{
    const r=await f.request();
    if(kind==="source")f.db.prepare("UPDATE sync_runs SET status='ok' WHERE id=?").run(f.cycle.runId);
    if(kind==="context")r.verifyContext=()=>false;
    if(kind==="budget")r.requestBudget=1;
    await assert.rejects(f.projector.run(r));assert.equal(f.store.pendingProjectionsForCourse(cid).length,1);
    assert.equal((await f.journal.inspect()).latestTerminal,null);if(kind!=="budget")assert.equal(f.calls.length,0);
  }finally{f.db.close();}}
});

test("actual request budget is shared across assignments rather than reset per transport",async()=>{
  const f=await fixture(2);try{
    const r=await f.request();r.requestBudget=4;
    await assert.rejects(f.projector.run(r));
    assert.equal(f.calls.length,4);assert.deepEqual(f.writes,[aid]);
    assert.deepEqual(f.store.pendingProjectionsForCourse(cid).map(p=>p.assignment_id),[aid+1]);
    assert.equal(f.state().outcomes.length,1);assert.equal(f.state().outcomes[0].requestsUsed,3);
    assert.equal((await f.journal.inspect()).latestTerminal,null);
  }finally{f.db.close();}
});

test("journal receipt failure after exact ack preserves outcome without replay or terminal",async()=>{
  const f=await fixture();try{
    const r=await f.request();r.verifyResult=async()=>{
      f.db.exec("CREATE TEMP TRIGGER reject_journal_receipt BEFORE UPDATE ON synthetic_compact_journal_v2 WHEN json_extract(NEW.document,'$.active.outcomes[0].status')='succeeded' BEGIN SELECT RAISE(ABORT,'dummy lost journal receipt'); END");return true;
    };
    await assert.rejects(f.projector.run(r));
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,0);
    assert.equal(f.state().outcomes.length,1);assert.equal(f.state().phase,"running");
    const raw=JSON.parse((f.db.prepare("SELECT document FROM synthetic_compact_journal_v2 WHERE slot=1").get() as any).document);
    assert.equal(raw.active.outcomes[0].status,"uncertain");assert.equal(raw.latestTerminal,null);
    const calls=f.calls.length;
    await assert.rejects(new SyntheticCanonicalProjector(f.storage,f.deps).run(r));assert.equal(f.calls.length,calls);
  }finally{f.db.close();}
});

test("canonical change during journal finish cannot publish a projection terminal checkpoint",async()=>{
  const f=await fixture();try{
    const r=await f.request();const finish=f.journal.finish.bind(f.journal);
    f.journal.finish=async handle=>{const terminal=await finish(handle);f.store.upsertAssignment({...assignment(aid),name:"dummy-after-finish"});return terminal;};
    await assert.rejects(f.projector.run(r));
    assert.equal(f.state().phase,"running");assert.equal(f.state().terminal,null);
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,1);
    assert.equal(f.store.lastSuccessfulSyncStart(),undefined);
  }finally{f.db.close();}
});

test("whole batch deadline includes waits between HTTP completion and durable receipt",async()=>{
  const f=await fixture();try{
    const r=await f.request();r.batchTimeoutMs=10;
    r.verifyResult=async()=>{await new Promise(resolve=>setTimeout(resolve,30));return true;};
    await assert.rejects(f.projector.run(r));
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,1);
    assert.equal((await f.journal.inspect()).latestTerminal,null);
  }finally{f.db.close();}
});

test("explicit terminal transition refuses altered prior receipt evidence before summarizing",async()=>{
  const f=await fixture(22);try{
    for(let i=0;i<20;i++)f.frozen.add(aid+i);
    const first=await f.projector.run(await f.request());
    const altered=f.state();altered.outcomes[0].receiptId="SYNTHETIC_altered_receipt";
    f.db.prepare("UPDATE synthetic_canonical_projection_v1 SET document=? WHERE slot=1").run(JSON.stringify(altered));
    const r=await f.request(first.state.attemptedAssignmentIds,first.terminal);const calls=f.calls.length;
    await assert.rejects(f.projector.run(r));assert.equal(f.calls.length,calls);
    assert.equal(f.state().outcomes.length,20);assert.equal(f.state().outcomes[0].receiptId,"SYNTHETIC_altered_receipt");
    assert.equal(f.store.pendingProjectionsForCourse(cid).length,22);
  }finally{f.db.close();}
});
