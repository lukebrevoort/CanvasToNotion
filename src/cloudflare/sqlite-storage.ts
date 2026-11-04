import type { JournalState, JournalStorage, JournalTransaction } from "./journal.js";

/** Structural subset of Cloudflare's SQLite Durable Object API. No Node ports. */
export interface DurableSqlStorage {
  sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] } };
  transactionSync<T>(callback: () => T): T;
  sync(): Promise<void>;
}

/** Experimental single-row ledger. A bounded prototype, not a full mirror store.
 * transactionSync provides isolation; sync is awaited BEFORE an effect is allowed.
 * A failed durability acknowledgment permanently blocks this adapter instance.
 */
export class DurableSqlJournalStorage implements JournalStorage {
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage) {}

  transaction<T>(callback: (transaction: JournalTransaction) => T): Promise<T> {
    const pending = this.tail.then(() => this.commit(callback));
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async commit<T>(callback: (transaction: JournalTransaction) => T): Promise<T> {
    if (this.failed) throw new Error("Journal durability is uncertain");
    const value = this.storage.transactionSync(() => {
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS sync_journal_v1 (slot INTEGER PRIMARY KEY CHECK (slot = 1), document TEXT NOT NULL)");
      let open = true;
      const assertOpen = () => { if (!open) throw new Error("Journal transaction has closed"); };
      const transaction: JournalTransaction = {
        get: () => {
          assertOpen();
          const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM sync_journal_v1 WHERE slot = 1").toArray();
          if (rows.length > 1) throw new Error("Ambiguous journal state");
          if (!rows.length) return undefined;
          return JSON.parse(rows[0]!.document) as JournalState;
        },
        put: state => {
          assertOpen();
          const document = JSON.stringify(state);
          if (new TextEncoder().encode(document).byteLength > 1_048_576) throw new Error("Prototype journal capacity exceeded");
          this.storage.sql.exec("INSERT INTO sync_journal_v1 (slot, document) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET document = excluded.document", document);
        },
      };
      try {
        const result = callback(transaction);
        if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") throw new Error("Synchronous journal transaction required");
        return result;
      } finally { open = false; }
    });
    try { await this.storage.sync(); }
    catch { this.failed = true; throw new Error("Journal durability is uncertain"); }
    return value;
  }
}
