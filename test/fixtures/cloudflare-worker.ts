/** Local Miniflare fixture only. No credentials, provider calls or deploy config. */
import { SingleWriterJournal, JournalError } from "../../src/cloudflare/journal.js";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
import { assignmentProperties } from "../../src/notion/projector-core.js";
import type { AssignmentRow } from "../../src/store/db.js";

const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
export class SyntheticJournalObject {
  private journal: SingleWriterJournal;
  constructor(private readonly state: { storage: DurableSqlStorage }) {
    this.journal = new SingleWriterJournal(new DurableSqlJournalStorage(state.storage));
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { action: string; runId?: string; generation?: number; loseReceipt?: boolean };
    try {
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
