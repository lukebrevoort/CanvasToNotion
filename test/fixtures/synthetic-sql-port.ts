/** Test-only generic JSON row port. Never stores actual credentials. */
import type { DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
export class SyntheticSqlPort<T> {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  constructor(private readonly storage: DurableSqlStorage) {}
  transaction<R>(callback: (transaction: { get(): T | undefined; put(value: T): void }) => R): Promise<R> {
    const work = this.tail.then(async () => {
      if (this.failed) throw new Error("Synthetic durability unresolved");
      const result = this.storage.transactionSync(() => {
        this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_auth_state (slot INTEGER PRIMARY KEY CHECK(slot=1), document TEXT NOT NULL)");
        let open = true;
        const check = () => { if (!open) throw new Error("Synthetic transaction closed"); };
        try {
          const value = callback({
            get: () => { check(); const row = this.storage.sql.exec<{document:string}>("SELECT document FROM synthetic_auth_state WHERE slot=1").toArray()[0]; return row ? JSON.parse(row.document) as T : undefined; },
            put: value => { check(); const document=JSON.stringify(value); if (document.length > 65536) throw new Error("Synthetic capacity exceeded"); this.storage.sql.exec("INSERT INTO synthetic_auth_state VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document", document); },
          });
          if (value && typeof (value as {then?:unknown}).then === "function") throw new Error("Synchronous callback required");
          return value;
        } finally { open=false; }
      });
      try { await this.storage.sync(); } catch { this.failed=true; throw new Error("Synthetic durability unresolved"); }
      return result;
    });
    this.tail=work.then(()=>undefined,()=>undefined);
    return work;
  }
}
