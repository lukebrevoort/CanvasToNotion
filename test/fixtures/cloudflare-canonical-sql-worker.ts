/** Local workerd only. No credentials, deployed resources, or external calls. */
import { createDurableSqlDatabase } from '../../src/cloudflare/canonical-sql.js';
import type { DurableSqlStorage } from '../../src/cloudflare/sqlite-storage.js';
import { canonicalScenario, inspectCanonical } from './canonical-sql-scenario.js';
export class SyntheticCanonicalSqlObject {
  constructor(private state: { storage: DurableSqlStorage }) {}
  async fetch(request: Request) {
    const db = createDurableSqlDatabase(this.state.storage);
    const result = new URL(request.url).pathname === '/run' ? canonicalScenario(db) : inspectCanonical(db);
    await this.state.storage.sync();
    return Response.json(result);
  }
}
export default {
  fetch(request: Request, env: { CANONICAL: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
    return env.CANONICAL.get(env.CANONICAL.idFromName('SYNTHETIC_canonical')).fetch(request);
  },
};
