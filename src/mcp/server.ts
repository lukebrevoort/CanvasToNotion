import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runSync } from "../sync/engine.js";
import { db, lastSyncRun, getAssignment, snapshotsFor, listActiveCourses } from "../store/db.js";

/**
 * Debug/verification MCP server. Oriented toward "double-check what Notion
 * shows" by comparing SQLite (canonical) against what a Notion MCP client sees.
 * Read-only except force_sync.
 */

const server = new McpServer({
  name: "canvas-to-notion-debug",
  version: "2.0.0",
});

server.tool(
  "sync_status",
  "Last sync run time/status/counts and overall tracking stats",
  {},
  async () => {
    const last = lastSyncRun();
    const courses = db.prepare("SELECT COUNT(*) AS n FROM courses WHERE active = 1").get() as { n: number };
    const assignments = db.prepare("SELECT COUNT(*) AS n FROM assignments").get() as { n: number };
    const snapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ lastRun: last ?? null, activeCourses: courses.n, assignments: assignments.n, snapshots: snapshots.n }, null, 2),
      }],
    };
  },
);

server.tool(
  "get_assignment",
  "Full SQLite record + snapshot history for a Canvas assignment ID",
  { assignmentId: z.number() },
  async ({ assignmentId }) => {
    const row = getAssignment(assignmentId);
    if (!row) return { content: [{ type: "text", text: `No assignment ${assignmentId} in local store.` }] };
    const snaps = snapshotsFor(assignmentId).map((s) => ({
      capturedAt: s.captured_at,
      changed: JSON.parse(s.changed_fields),
    }));
    const { description_html, ...rest } = row;
    return {
      content: [{ type: "text", text: JSON.stringify({ ...rest, descriptionLength: description_html?.length ?? 0, snapshots: snaps }, null, 2) }],
    };
  },
);

server.tool(
  "verify_assignment",
  "Live re-fetch from Canvas; reports drift between Canvas, SQLite, and what we last pushed",
  { assignmentId: z.number() },
  async ({ assignmentId }) => {
    const row = getAssignment(assignmentId);
    if (!row) return { content: [{ type: "text", text: `No assignment ${assignmentId} in local store.` }] };
    const { config } = await import("../config.js");
    const { resolveAuth } = await import("../canvas/auth.js");
    const { CanvasClient } = await import("../canvas/client.js");
    const canvas = new CanvasClient(config.canvasDomain, resolveAuth());
    try {
      const liveAssignments = await Array.fromAsync(canvas.assignments(row.course_id));
      const liveAssignment = liveAssignments.find((a: { id: number }) => a.id === assignmentId);
      if (!liveAssignment) return { content: [{ type: "text", text: `Canvas no longer returns assignment ${assignmentId}.` }] };
      const drift: string[] = [];
      if (liveAssignment.name !== row.name) drift.push(`name: canvas="${liveAssignment.name}" store="${row.name}"`);
      if ((liveAssignment.due_at ?? null) !== row.due_at) drift.push(`due_at: canvas=${liveAssignment.due_at} store=${row.due_at}`);
      if ((liveAssignment.points_possible ?? null) !== row.points_possible) drift.push(`points: canvas=${liveAssignment.points_possible} store=${row.points_possible}`);
      const sub = (liveAssignment as unknown as { submission?: { score?: number | null } }).submission;
      if (sub && (sub.score ?? null) !== row.sub_score) drift.push(`score: canvas=${sub.score} store=${row.sub_score}`);
      return {
        content: [{ type: "text", text: drift.length === 0 ? `✅ ${assignmentId} in sync with Canvas.` : `⚠️ Drift:\n${drift.join("\n")}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Live check failed: ${e instanceof Error ? e.message : e}` }] };
    }
  },
);

server.tool(
  "force_sync",
  "Trigger a sync run now (pass --full via full=true for a complete re-pull)",
  { full: z.boolean().optional() },
  async ({ full }) => {
    const result = await runSync({ full });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.tool(
  "list_courses",
  "Courses currently tracked in the local store",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(listActiveCourses(), null, 2) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("canvas-to-notion debug MCP server running on stdio");
