import { config } from "./config.js";
import { resolveAuth, saveOAuthCredentials } from "./canvas/auth.js";
import { CanvasClient } from "./canvas/client.js";
import { qrLogin } from "./canvas/qr-login.js";
import { createCanvasHq, savedDbIds } from "./notion/schema.js";
import { runSync } from "./sync/engine.js";
import { db, lastSyncRun } from "./store/db.js";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "setup": {
      const ids = await createCanvasHq();
      console.log("✅ Created Canvas HQ in Notion:");
      console.log(`   Assignments DB: ${ids.assignmentsDbId}`);
      console.log(`   Courses DB:     ${ids.coursesDbId}`);
      console.log("IDs saved to data/state.json — no .env changes needed.");
      break;
    }

    case "auth-token": {
      const token = args[0] ?? process.env.CANVAS_TOKEN;
      if (!token) {
        console.error("Usage: npm run auth:token -- <paste-your-access-token>");
        console.error("(Create at Canvas → Account → Settings → + New Access Token, no expiration)");
        process.exit(1);
      }
      const canvas = new CanvasClient(config.canvasDomain, {
        headers: async () => ({ Authorization: `Bearer ${token}` }),
        describe: () => "token",
      });
      const { user } = await canvas.verify();
      console.log(`✅ Token valid — authenticated as ${user.name} (${user.id}).`);
      console.log("Add it to your .env as CANVAS_TOKEN=<token>.");
      break;
    }

    case "auth-qr": {
      const qrUrl = args[0];
      if (!qrUrl) {
        console.error('Usage: npm run auth:qr -- "<decoded QR URL>"');
        console.error("Steps: Canvas → Account → QR for Mobile Login → decode the QR with any reader → paste the URL here.");
        console.error("The code is one-shot and expires 10 minutes after the QR is shown.");
        process.exit(1);
      }
      const creds = await qrLogin(qrUrl);
      saveOAuthCredentials(creds);
      console.log(`✅ OAuth credentials saved (${creds.user?.name ?? "unknown user"}). They refresh automatically.`);
      break;
    }

    case "verify": {
      const canvas = new CanvasClient(config.canvasDomain, resolveAuth());
      const { auth, user } = await canvas.verify();
      console.log(`✅ Canvas OK (${auth}) as ${user.name} (${user.id})`);
      break;
    }

    case "sync": {
      const full = args.includes("--full");
      const result = await runSync({ full });
      console.log(`✅ Sync #${result.runId}: ${result.coursesSeen} courses, ${result.assignmentsSeen} assignments, ${result.changesPushed} changes pushed.`);
      for (const e of result.errors) console.error(`   ⚠️  ${e}`);
      break;
    }

    case "status": {
      const last = lastSyncRun();
      if (!last) {
        console.log("No syncs recorded yet.");
      } else {
        console.log(`Last run #${last.id}: ${last.status} at ${last.finished_at}`);
        console.log(`  courses=${last.courses_seen} assignments=${last.assignments_seen} pushed=${last.changes_pushed}`);
        if (last.error) console.log(`  error: ${last.error}`);
      }
      const courses = db.prepare("SELECT COUNT(*) AS n FROM courses WHERE active = 1").get() as { n: number };
      const assignments = db.prepare("SELECT COUNT(*) AS n FROM assignments").get() as { n: number };
      const snaps = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
      console.log(`Tracking ${courses.n} active courses, ${assignments.n} assignments, ${snaps.n} snapshots.`);
      const ids = savedDbIds();
      console.log(`Notion DBs: assignments=${ids.assignmentsDbId || "(not set up)"} courses=${ids.coursesDbId || "(not set up)"}`);
      break;
    }

    default:
      console.log(`canvas-to-notion v2

Usage:
  npm run setup              Create Canvas HQ (Assignments + Courses DBs) in Notion
  npm run auth:token -- <t>  Validate a personal access token (primary path)
  npm run auth:qr -- "<url>" Bootstrap OAuth via mobile QR code (fallback path)
  npm run verify             Check Canvas connectivity + which auth is live
  npm run sync [--full]      Run one sync (incremental by default)
  npm run status             Show last run + tracked counts
  npm run mcp                Start the debug MCP server (stdio)`);
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
