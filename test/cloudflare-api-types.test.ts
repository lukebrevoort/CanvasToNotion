import test from "node:test";
import assert from "node:assert/strict";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";

// Compile-time assertion against the pinned official platform API types.
type Compatible = DurableObjectStorage extends DurableSqlStorage ? true : false;
const compatible: Compatible = true;
test("storage port accepts official Durable Object storage type", () => assert.equal(compatible, true));
