/** Local Miniflare fixture only. No credentials, provider calls or deploy config. */
import { SingleWriterJournal, JournalError } from "../../src/cloudflare/journal.js";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
import { assignmentProperties } from "../../src/notion/projector-core.js";
import type { AssignmentRow } from "../../src/store/db.js";

import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from "../../src/cloudflare/auth-state.js";
import { SyntheticSqlPort } from "./synthetic-sql-port.js";
import { SyntheticMirrorImporter } from "../../src/cloudflare/mirror-import.js";
import { runDummyBatch, type BatchCheckpoint } from "../../src/cloudflare/batches.js";
import { SyntheticJsonTransport, SyntheticTransportError } from "../../src/cloudflare/transport.js";
import { SyntheticCoordinator, type ReadinessReference, type CoordinatorReceipt } from "../../src/cloudflare/coordinator.js";
const authScope = { syntheticOnly: true as const, accountId: "dummy-account", sourceId: "canvas.invalid", destinationId: "dummy-notion-ds" };
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const mirrorFixture = {
          schemaVersion: 1, scope: "synthetic-only", importId: "dummy-import-1", binding,
          courses: [{canvas_id:990000001,name:"Dummy course"}],
          assignments: [{canvas_id:990000020,course_id:990000001,name:"Dummy assignment"}],
          snapshots: [], watermark: null,
          notionState: {assignmentsDbId:"dummy-assignment-db",assignmentsDsId:"SYNTHETIC_notion",coursesDbId:"dummy-course-db",coursesDsId:"dummy-course-ds"},
          protectedPages: [{assignmentId:990000020,pageId:"dummy-page",hidden:true,inProgress:true,doNotSync:true,notes:[{text:"Dummy note sentinel"}],activity:[{text:"Dummy history sentinel"}]}],
          pendingProjections: [], unresolvedRuns: [],
        };
export class SyntheticJournalObject {
  private journal: SingleWriterJournal;
  private auth?: Promise<SyntheticAuthStateAdapter>;
  private coordinator?: SyntheticCoordinator;
  private coordinatorAdapter() {
    return this.coordinator ??= new SyntheticCoordinator(this.state.storage,binding,async (ref:ReadinessReference,receipt:CoordinatorReceipt)=>{
      const imported=await new SyntheticMirrorImporter(this.state.storage).inspect();
      if (!imported || ref.artifactId!=="SYNTHETIC_mirror") return false;
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(imported)))),v=>v.toString(16).padStart(2,"0")).join("");
      const journal=await this.journal.inspect();
      if (digest!==ref.artifactDigest || journal.generation!==ref.journalGeneration || journal.activeRunId!==null || journal.runs.some(r=>r.status!=="succeeded")) return false;
      if (ref.journalGeneration===0) return ref.cursorId==="SYNTHETIC_cursor_0" && receipt.receiptId==="SYNTHETIC_import_receipt" && receipt.componentReceiptIds.length===1 && receipt.componentReceiptIds[0]==="SYNTHETIC_import";
      if(ref.journalGeneration>2 || journal.runs.length!==ref.journalGeneration) return false;
      const plan={mode:"dummy",planId:"SYNTHETIC_composed",binding,operations:[1,2].map(i=>({operationId:`SYNTHETIC_composed${i}`,kind:"write",targetId:`SYNTHETIC_page${i}`,requestDigest:"d".repeat(64),requestCount:1}))};
      const planDigest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(plan)))),v=>v.toString(16).padStart(2,"0")).join("");
      for(let index=0;index<journal.runs.length;index++) {
        const run=journal.runs[index]!; const op=run.operations[0]; const expected=plan.operations[index]!;
        if(run.runId!==`SYNTHETIC_batch_${plan.planId.length}_${plan.planId}_${planDigest}_${index}_${index+1}` || run.generation!==index || run.completedGeneration!==index+1 || run.operations.length!==1 || !op || op.operationId!==expected.operationId || op.kind!==expected.kind || op.targetId!==expected.targetId || op.requestDigest!==expected.requestDigest || op.outcome!=="succeeded" || !op.acknowledged || op.receipt.receiptId!==`SYNTHETIC_receipt_${planDigest}_${index}`) return false;
      }
      const last=journal.runs.at(-1)!;
      return receipt.receiptId===`SYNTHETIC_complete_${ref.journalGeneration}` && ref.cursorId===`SYNTHETIC_cursor_${ref.journalGeneration}` && receipt.componentReceiptIds.length===1 && receipt.componentReceiptIds[0]===last.runId;
    });
  }
  private authAdapter() {
    return this.auth ??= (async () => {
      // Public deterministic fixture bytes, never a real encryption key.
      const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt", "decrypt"]);
      return new SyntheticAuthStateAdapter({ scope: authScope, storage: new SyntheticSqlPort<SyntheticAuthStateRecord>(this.state.storage), cipher: createSyntheticAesGcmCipher(key) });
    })();
  }
  constructor(private readonly state: { storage: DurableSqlStorage }) {
    this.journal = new SingleWriterJournal(new DurableSqlJournalStorage(state.storage));
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { action: string; runId?: string; generation?: number; loseReceipt?: boolean; checkpoint?: BatchCheckpoint; reference?: ReadinessReference };
    try {
      if (input.action === "coordinator_corrupt_receipt") {
        // Fault injection confined to local synthetic SQLite, never provider data.
        this.state.storage.transactionSync(()=>{
          const row=this.state.storage.sql.exec<{document:string}>("SELECT document FROM sync_journal_v1 WHERE slot=1").toArray()[0]!;
          const journal=JSON.parse(row.document); journal.runs[0].operations[0].receipt.receiptId="SYNTHETIC_wrong_receipt";
          this.state.storage.sql.exec("UPDATE sync_journal_v1 SET document=? WHERE slot=1",JSON.stringify(journal));
        });
        await this.state.storage.sync(); return Response.json({injected:true});
      }
      if (input.action === "coordinator_import") {
        await this.journal.initialize(binding);
        const gate=this.coordinatorAdapter(); await gate.initialize();
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(mirrorFixture)))),v=>v.toString(16).padStart(2,"0")).join("");
        return Response.json(await gate.importArtifact({operationId:"SYNTHETIC_import",reference:{artifactId:"SYNTHETIC_mirror",artifactDigest:digest,cursorId:"SYNTHETIC_cursor_0",journalGeneration:0}},async()=>{
          await new SyntheticMirrorImporter(this.state.storage).importDocument(mirrorFixture);
          if(input.loseReceipt) throw new Error("Synthetic import receipt lost");
          return {receiptId:"SYNTHETIC_import_receipt",componentReceiptIds:["SYNTHETIC_import"]};
        }));
      }
      if (input.action === "coordinator_batch") {
        const gate=this.coordinatorAdapter();
        const expected=input.reference!; const generation=expected.journalGeneration;
        let batch;
        const readiness=await gate.run({operationId:`SYNTHETIC_batch_${generation}`,expected,next:{...expected,cursorId:`SYNTHETIC_cursor_${generation+1}`,journalGeneration:generation+1}},async()=>{
          batch=await runDummyBatch(this.journal,{mode:"dummy",planId:"SYNTHETIC_composed",binding,operations:[1,2].map(i=>({operationId:`SYNTHETIC_composed${i}`,kind:"write" as const,targetId:`SYNTHETIC_page${i}`,requestDigest:"d".repeat(64),requestCount:1}))},{expectedGeneration:generation,maxRequests:1,maxEffects:1,checkpoint:input.checkpoint},async()=>{
            const transport=new SyntheticJsonTransport({syntheticOnly:true,origin:"https://notion.invalid",requestBudget:1,fetch:async()=>{
              this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_effects (id INTEGER PRIMARY KEY,count INTEGER NOT NULL)");
              this.state.storage.sql.exec("INSERT INTO synthetic_effects VALUES(1,1) ON CONFLICT(id) DO UPDATE SET count=count+1");
              await this.state.storage.sync();
              if(input.loseReceipt) throw new Error("Synthetic composed effect receipt lost");
              return Response.json({dummy:true});
            }});
            await transport.request({url:"https://notion.invalid/dummy",method:"PATCH",json:{dummy:true}});
          });
          return {receiptId:`SYNTHETIC_complete_${generation+1}`,componentReceiptIds:[batch.checkpoint.completedRunId]};
        });
        return Response.json({readiness,batch});
      }
      if(input.action === "coordinator_inspect") return Response.json(await this.coordinatorAdapter().inspect());
      if (input.action === "transport") {
        let calls = 0;
        const transport = new SyntheticJsonTransport({ syntheticOnly:true,origin:"https://notion.invalid",requestBudget:1,fetch:async (_url, init) => {
          calls++;
          if (init?.redirect !== "manual" || init.credentials !== "omit") throw new Error("Fixture transport options wrong");
          return Response.json({dummy:true});
        }});
        const result = await transport.request({url:"https://notion.invalid/dummy"});
        let blocked = false;
        try { await transport.request({url:"https://notion.invalid/dummy"}); } catch (e) { blocked = e instanceof SyntheticTransportError && e.code === "budget"; }
        return Response.json({result,calls,blocked,state:transport.state()});
      }
      if (input.action === "transport_timeout") {
        let release!: (value:Response)=>void;
        const transport = new SyntheticJsonTransport({ syntheticOnly:true,origin:"https://notion.invalid",requestBudget:2,timeoutMs:10,fetch:async()=>new Promise<Response>(resolve=>{release=resolve;}) });
        let code;
        try { await transport.request({url:"https://notion.invalid/dummy",method:"PATCH",json:{dummy:true}}); } catch (e) { code = e instanceof SyntheticTransportError ? e.code : "unexpected"; }
        const during=transport.state();
        release(Response.json({dummy:true}));
        await transport.settleStartedRequests();
        let blocked=false;
        try { await transport.request({url:"https://notion.invalid/dummy"}); } catch (e) { blocked=e instanceof SyntheticTransportError && e.code==="uncertain"; }
        return Response.json({code,during,after:transport.state(),blocked});
      }
      if (input.action === "mirror_import") {
        return Response.json(await new SyntheticMirrorImporter(this.state.storage).importDocument(mirrorFixture));
      }
      if (input.action === "mirror_inspect") return Response.json(await new SyntheticMirrorImporter(this.state.storage).inspect());
      if (input.action === "batch") {
        const result = await runDummyBatch(this.journal, { mode:"dummy",planId:"SYNTHETIC_plan",binding,operations:[1,2,3].map(i=>({operationId:`SYNTHETIC_op${i}`,kind:"write" as const,targetId:`SYNTHETIC_page${i}`,requestDigest:"c".repeat(64),requestCount:2})) }, { expectedGeneration:input.generation!,maxRequests:3,maxEffects:2,checkpoint:input.checkpoint }, async () => {
          this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_effects (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
          this.state.storage.sql.exec("INSERT INTO synthetic_effects VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1");
          await this.state.storage.sync();
          if (input.loseReceipt) throw new Error("Synthetic batch receipt lost");
        });
        return Response.json(result);
      }
      if (input.action === "auth_initialize") {
        await this.journal.initialize(authScope);
        await (await this.authAdapter()).initialize({ accessToken: "dummy-access-0", refreshToken: "dummy-refresh-0", expiresAt: 123456 });
        return Response.json({ initialized: true });
      }
      if (input.action === "auth_inspect") {
        const document = this.state.storage.sql.exec<{document:string}>("SELECT document FROM synthetic_auth_state WHERE slot=1").toArray()[0]!.document;
        return Response.json({ auth: await (await this.authAdapter()).inspect(), journal: await this.journal.inspect(), plaintextAbsent: !document.includes("dummy-access-") && !document.includes("dummy-refresh-") });
      }
      if (input.action === "auth_refresh") {
        const generation = input.generation!;
        const handle = await this.journal.admit({ ...authScope, runId: `dummy-auth-${generation}`, expectedGeneration: generation });
        let preserved = false;
        await (await this.authAdapter()).refresh({ expectedGeneration: generation, journal: this.journal, handle, operationId: `dummy-refresh-${generation}`, requestDigest: "b".repeat(64), exchange: async old => {
          preserved = old.refreshToken === "dummy-refresh-0";
          if (input.loseReceipt) throw new Error("Synthetic response lost");
          return { accessToken: `dummy-access-${generation+1}`, expiresAt: 234567 + generation };
        } });
        return Response.json({ generation: await this.journal.finish(handle), preserved });
      }
      if (input.action === "project") {
        const row = { canvas_id: 42, course_id: 1, name: "SYNTHETIC_assignment", submission_types: "[]" } as AssignmentRow;
        return Response.json(assignmentProperties(row, "synthetic.invalid", "SYNTHETIC_course"));
      }
      if (input.action === "initialize") { await this.journal.initialize(binding); return Response.json({ initialized: true }); }
      if (input.action === "inspect") {
        const journal = await this.journal.inspect();
        this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_effects (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
        const effects = this.state.storage.sql.exec<{ count: number }>("SELECT count FROM synthetic_effects WHERE id = 1").toArray()[0]?.count ?? 0;
        return Response.json({ journal, effects });
      }
      if (input.action !== "run" || !input.runId?.startsWith("SYNTHETIC_") || !Number.isSafeInteger(input.generation)) return new Response("Invalid fixture request", { status: 400 });
      const handle = await this.journal.admit({ ...binding, runId: input.runId, expectedGeneration: input.generation! });
      await this.journal.execute(handle, { operationId: "SYNTHETIC_operation", kind: "write", targetId: "SYNTHETIC_page", requestDigest: "a".repeat(64) }, async () => {
        this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_effects (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
        this.state.storage.sql.exec("INSERT INTO synthetic_effects VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1");
        await this.state.storage.sync();
        if (input.loseReceipt) throw new Error("SYNTHETIC lost receipt");
        return { receiptId: "SYNTHETIC_receipt" };
      });
      return Response.json({ generation: await this.journal.finish(handle) });
    } catch (error) {
      return Response.json({ code: error instanceof JournalError ? error.code : "uncertain" }, { status: 409 });
    }
  }
}

export default {
  fetch(request: Request, env: { JOURNAL: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    if (!/^SYNTHETIC_[a-z_]+$/.test(name)) return Promise.resolve(new Response("Fixture only", { status: 400 }));
    return env.JOURNAL.get(env.JOURNAL.idFromName(name)).fetch(request);
  },
};
