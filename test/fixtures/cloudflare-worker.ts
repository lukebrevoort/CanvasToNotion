/** Local Miniflare fixture only. No credentials, provider calls or deploy config. */
import { SingleWriterJournal, JournalError } from "../../src/cloudflare/journal.js";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
import { assignmentProperties } from "../../src/notion/projector-core.js";
import type { AssignmentRow } from "../../src/store/db.js";

import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from "../../src/cloudflare/auth-state.js";
import { SyntheticSqlPort } from "./synthetic-sql-port.js";
import { SyntheticMirrorImporter } from "../../src/cloudflare/mirror-import.js";
import { runDummyBatch, type BatchCheckpoint } from "../../src/cloudflare/batches.js";
const authScope = { syntheticOnly: true as const, accountId: "dummy-account", sourceId: "canvas.invalid", destinationId: "dummy-notion-ds" };
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
export class SyntheticJournalObject {
  private journal: SingleWriterJournal;
  private auth?: Promise<SyntheticAuthStateAdapter>;
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
    const input = await request.json() as { action: string; runId?: string; generation?: number; loseReceipt?: boolean; checkpoint?: BatchCheckpoint };
    try {
      if (input.action === "mirror_import") {
        return Response.json(await new SyntheticMirrorImporter(this.state.storage).importDocument({
          schemaVersion: 1, scope: "synthetic-only", importId: "dummy-import-1", binding,
          courses: [{canvas_id:990000001,name:"Dummy course"}],
          assignments: [{canvas_id:990000020,course_id:990000001,name:"Dummy assignment"}],
          snapshots: [], watermark: null,
          notionState: {assignmentsDbId:"dummy-assignment-db",assignmentsDsId:"SYNTHETIC_notion",coursesDbId:"dummy-course-db",coursesDsId:"dummy-course-ds"},
          protectedPages: [{assignmentId:990000020,pageId:"dummy-page",hidden:true,inProgress:true,doNotSync:true,notes:[{text:"Dummy note sentinel"}],activity:[{text:"Dummy history sentinel"}]}],
          pendingProjections: [], unresolvedRuns: [],
        }));
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
