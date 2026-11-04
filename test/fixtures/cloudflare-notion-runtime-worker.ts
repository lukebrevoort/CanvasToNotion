/** Local workerd fixture only. Every adapter HTTP request uses the pure fake. */
import { fixture, row, options, destinations } from "./synthetic-notion-http.js";
import { upsertAssignmentPage } from "../../src/notion/projector-core.js";
import { ensureRevisionActivity, projectionActivity } from "../../src/notion/activity.js";
const errorOf = async (action: () => Promise<unknown>) => {
  try { await action(); return null; } catch (error) { return error instanceof Error ? error.message : "unknown"; }
};
export default {
  async fetch(request: Request) {
    const f = fixture();
    if (new URL(request.url).pathname === "/projection") {
      const results = [];
      for (let i = 0; i < 2; i++) results.push(await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", options, destinations));
      const afterReplay = structuredClone(f.blocks());
      f.properties["Do Not Sync"].checkbox = true;
      const before = f.calls.length;
      results.push(await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", options, destinations));
      return Response.json({ results, original: f.original, afterReplay, blocks: f.blocks(), properties: f.properties, calls: f.calls, frozenCalls: f.calls.slice(before) });
    }
    if (new URL(request.url).pathname === "/lost-response") {
      const client = f.fresh();
      const activity = projectionActivity({ assignmentId: 42, revision: options.revision, changedFields: ["sub_score"], isNew: false })!;
      f.loseAppend();
      const lost = await errorOf(() => ensureRevisionActivity(client, "dummy-page", activity));
      const before = f.calls.length;
      const poisoned = await errorOf(() => ensureRevisionActivity(client, "dummy-page", activity));
      const after = f.calls.length;
      const reconciled = await ensureRevisionActivity(f.fresh(), "dummy-page", activity);
      return Response.json({ lost, poisoned, before, after, reconciled, blocks: f.blocks(), calls: f.calls });
    }
    return new Response("Fixture only", { status: 404 });
  },
};
