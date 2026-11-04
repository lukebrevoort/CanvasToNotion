# Cloudflare projector compatibility investigation

Prepared 2026-11-04. Dummy/local prototype only. No resources, deployment, credentials, real state or API mutation.

## Extraction

`src/notion/projector-core.ts` contains the verified projection implementation with explicit destination IDs. Worker callers use:

- `upsertAssignmentPage(client, row, domain, options, { assignmentsDbId, assignmentsDsId })`
- `upsertCoursePage(client, course, domain, { coursesDbId, coursesDsId })`

`src/notion/projector.ts` retains the Node API and resolves saved destinations once per call. It re-exports the identical property renderer. Runtime dependencies from the core are only activity.ts and blocks.ts. SDK Client and AssignmentRow imports are type-only and disappear from emitted code; no config, fs, SQLite or SDK runtime import is pulled in by the core. Tests inspect that emitted dependency graph and compare Node/core outputs and request payloads. Existing identity and Activity/Notes/override regression cases continue to pass.

The extracted core is dependency-injected, not side-effect-free: it still calls the supplied client to project Notion pages. Worker deployment must supply a guarded/journaled adapter, not an untracked SDK. It does not implement durable admission, OAuth refresh, canonical storage or an external-writer fence. Node wrappers resolve configuration once; a configuration file changing during a single course projection is no longer reread midway through creation.

## Current official test setup

Current Cloudflare documentation now specifies `vitest@^4.1.0` plus `@cloudflare/vitest-plugin`; configure `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })` in the Vitest plugins array. Do not copy older vitest-pool-workers/defineWorkersConfig examples without version review. Generate runtime/binding declarations with `wrangler types`; test types include `@cloudflare/vitest-plugin/types`. Keep this separate from existing Node tests.

Source: https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/

DO test APIs include `runInDurableObject(stub, callback)` to inspect instance/storage and `evictDurableObject(stub)` to test reconstruction with storage preserved. These operate only on classes in the main Worker. Use mocked outbound transport and fail unmocked calls. The existing Node fake-client tests are not proof of workerd compatibility; platform tests must actually load the pure core under the Workers runtime and exercise storage persistence plus late/unknown outcomes.

Source: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/

## Durable storage compatibility

For SQLite-backed DOs, use `ctx.storage.sql.exec()` and `ctx.storage.transactionSync()` for synchronous journal transactions. Raw BEGIN/SAVEPOINT SQL is unsupported. The transactionSync callback must not return a Promise, so remote fetch must be outside that transaction. Persist intent first; await remote work; persist observation separately. Reconstruct unresolved intent conservatively after eviction. Durable local transactions do not make a remote Notion mutation atomic.

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

SQLite-backed DO class creation uses `new_sqlite_classes` migrations. Free plan supports SQLite-backed DOs; $0 is a target subject to actual plan/quotas, not a guarantee from this code. Free quotas cause operations to fail when exceeded. Pending I/O can keep objects active and consume duration, so unresolved-request design must not assume a permanently running in-memory supervisor survives indefinitely.

Sources:
- https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

## Verification at handoff

25 Node tests passed: pure-core extraction tests plus unchanged projection properties, identity pagination/ambiguity, Activity replay and preservation tests. TypeScript typecheck passed. No package changes or installations were made by the projector worker; platform wrapper/package setup belongs to the parent task.

Lifecycle caution: `blockConcurrencyWhile` resets the object if its callback exceeds30 seconds. Do not use it as an unbounded lock around remote writes. `waitUntil` prevents eviction only until settlement or15 minutes. This reinforces durable uncertainty recovery rather than resident-process assumptions. Source: https://developers.cloudflare.com/durable-objects/api/state/
