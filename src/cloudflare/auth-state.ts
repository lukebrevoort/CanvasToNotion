/** Dummy-only encrypted auth-state experiment. No provider, credential loading,
 * network, retry, key provisioning or production activation exists here.
 * Storage, encryption and journal orchestration are trusted injected ports.
 * Separate auth/journal commits deliberately fail closed: a crash after token
 * persistence but before receipt acknowledgment leaves the journal uncertain.
 * There is no recovery/reset API. Do not dispatch refresh outside the journal.
 */
import type { EffectReceipt, JournalBinding, OperationIntent, RunHandle, SingleWriterJournal } from "./journal.js";

export interface SyntheticAuthScope extends JournalBinding { syntheticOnly: true }
export interface SyntheticTokens { accessToken: string; refreshToken: string; /** Absolute Unix epoch milliseconds. */ expiresAt: number }
export interface SyntheticRefreshResponse { accessToken: string; refreshToken?: string; /** Absolute Unix epoch milliseconds. */ expiresAt: number }
export interface AuthCipherContext { schemaVersion: 1; binding: SyntheticAuthScope; generation: number }
export interface EncryptedAuthEnvelope { algorithm: "AES-GCM"; iv: string; ciphertext: string }
export interface SyntheticAuthCipher {
  seal(tokens: SyntheticTokens, context: AuthCipherContext): Promise<EncryptedAuthEnvelope>;
  open(envelope: EncryptedAuthEnvelope, context: AuthCipherContext): Promise<SyntheticTokens>;
}
export interface SyntheticAuthStateRecord extends AuthCipherContext {
  status: "ready" | "uncertain";
  envelope: EncryptedAuthEnvelope;
}
export interface AuthStateTransaction {
  get(): SyntheticAuthStateRecord | undefined;
  put(value: SyntheticAuthStateRecord): void;
}
export interface AuthStateStorage {
  /** Serializable synchronous callback, isolated values, atomic durable commit.
   * Serialize through durability acknowledgment, reject unknown commit outcome.
   * Never invoke an external effect from within this callback. */
  transaction<T>(callback: (transaction: AuthStateTransaction) => T): Promise<T>;
}
export class AuthStateError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "uncertain" | "busy" | "expired") {
    super(`Synthetic auth state: ${code}`); this.name = "AuthStateError";
  }
}
function fail(code: AuthStateError["code"]): never { throw new AuthStateError(code); }
function checkGeneration(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) fail("invalid");
}
function scopeCopy(value: SyntheticAuthScope): SyntheticAuthScope {
  if (value?.syntheticOnly !== true) fail("invalid");
  const canonical = value.accountId === "SYNTHETIC_account" && value.sourceId === "SYNTHETIC_canvas" && value.destinationId === "SYNTHETIC_notion";
  const dummy = /^dummy-[a-zA-Z0-9_-]{1,80}$/.test(value.accountId) && value.sourceId === "canvas.invalid" && /^dummy-[a-zA-Z0-9_-]{1,80}$/.test(value.destinationId);
  if (!canonical && !dummy) fail("invalid");
  return { syntheticOnly: true, accountId: value.accountId, sourceId: value.sourceId, destinationId: value.destinationId };
}
function checkedTokens(value: SyntheticTokens): SyntheticTokens {
  if (!value || !/^dummy-[a-zA-Z0-9_-]{1,200}$/.test(value.accessToken) ||
      !/^dummy-[a-zA-Z0-9_-]{1,200}$/.test(value.refreshToken) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) fail("invalid");
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
}
const sameBinding = (a: JournalBinding, b: JournalBinding) => a.accountId === b.accountId && a.sourceId === b.sourceId && a.destinationId === b.destinationId;
function checkedEnvelope(value: EncryptedAuthEnvelope): EncryptedAuthEnvelope {
  if (!value || value.algorithm !== "AES-GCM" || typeof value.iv !== "string" || typeof value.ciphertext !== "string" ||
      !/^[A-Za-z0-9+/]{16}$/.test(value.iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext) || value.ciphertext.length > 8192) fail("invalid");
  return { algorithm: "AES-GCM", iv: value.iv, ciphertext: value.ciphertext };
}

export class SyntheticAuthStateAdapter {
  private readonly scope: SyntheticAuthScope;
  private quarantined = false;
  private busy = false;
  constructor(private readonly ports: { scope: SyntheticAuthScope; storage: AuthStateStorage; cipher: SyntheticAuthCipher }) {
    this.scope = scopeCopy(ports.scope);
  }
  private context(generation: number): AuthCipherContext { return { schemaVersion: 1, binding: structuredClone(this.scope), generation }; }
  private state(transaction: AuthStateTransaction): SyntheticAuthStateRecord {
    const value = transaction.get();
    if (!value || value.schemaVersion !== 1 || value.binding.syntheticOnly !== true || !sameBinding(value.binding, this.scope)) fail("conflict");
    checkGeneration(value.generation); checkedEnvelope(value.envelope);
    if (value.status !== "ready" && value.status !== "uncertain") fail("invalid");
    return structuredClone(value);
  }
  private async transact<T>(callback: (transaction: AuthStateTransaction) => T): Promise<T> {
    try { return await this.ports.storage.transaction(callback); }
    catch (error) {
      if (error instanceof AuthStateError) throw error;
      this.quarantined = true; throw new AuthStateError("uncertain");
    }
  }
  async initialize(input: SyntheticTokens): Promise<void> {
    if (this.quarantined) fail("uncertain");
    const tokens = checkedTokens(input);
    let envelope: EncryptedAuthEnvelope;
    try { envelope = checkedEnvelope(await this.ports.cipher.seal(tokens, this.context(0))); }
    catch { this.quarantined = true; throw new AuthStateError("uncertain"); }
    await this.transact(transaction => {
      if (this.quarantined) fail("uncertain");
      if (transaction.get()) fail("conflict");
      transaction.put({ ...this.context(0), status: "ready", envelope });
    });
  }
  async inspect(): Promise<{ generation: number; status: "ready" | "uncertain"; locallyQuarantined: boolean }> {
    const value = await this.transact(transaction => this.state(transaction));
    return { generation: value.generation, status: value.status, locallyQuarantined: this.quarantined };
  }
  /** Access token is released only to an awaited trusted effect after durable
   * journal intent. The callback must not retain tokens or start background work.
   * No refresh token, raw response, header builder or token getter is exposed.
   * Journal instance/storage must be the same authoritative binding as refresh.
   */
  async withAccessToken(options: {
    expectedGeneration: number; journal: SingleWriterJournal; handle: RunHandle;
    intent: OperationIntent;
    /** Injected clock returning absolute Unix epoch milliseconds, sampled again before dispatch. */
    nowMs: () => number;
    /** Required remaining validity, from zero to five minutes inclusive. */
    minValidityMs: number;
    use: (accessToken: string) => Promise<EffectReceipt>;
  }): Promise<EffectReceipt> {
    if (this.quarantined) fail("uncertain");
    if (this.busy) fail("busy");
    checkGeneration(options.expectedGeneration);
    if (!sameBinding(options.handle, this.scope) || options.intent?.kind !== "write" || typeof options.use !== "function") fail("invalid");
    const expected = options.expectedGeneration, handle = structuredClone(options.handle);
    const intent: OperationIntent = { operationId: options.intent.operationId, kind: "write", targetId: options.intent.targetId, requestDigest: options.intent.requestDigest };
    const use = options.use, journal = options.journal;
    const nowMs = options.nowMs, minValidityMs = options.minValidityMs;
    if (typeof nowMs !== "function" || !Number.isSafeInteger(minValidityMs) || minValidityMs < 0 || minValidityMs > 300_000) fail("invalid");
    const currentTime = () => {
      let value: number;
      try { value = nowMs(); } catch { return fail("invalid"); }
      if (!Number.isSafeInteger(value) || value < 0) fail("invalid");
      return value;
    };
    const assertValid = (tokens: SyntheticTokens) => {
      const remaining = tokens.expiresAt - currentTime();
      if (remaining <= 0 || remaining < minValidityMs) fail("expired");
    };
    currentTime();
    const readReady = () => this.transact(transaction => {
      if (this.quarantined) fail("uncertain");
      const current = this.state(transaction);
      if (current.status !== "ready") fail("uncertain");
      if (current.generation !== expected) fail("conflict");
      return current;
    });
    this.busy = true;
    try {
      // Preflight uses plaintext internally for expiry only. It exposes no token
      // and records no effect intent, so known expiry can be explicitly refreshed.
      // Read-only ownership check precedes even internal expiry decryption.
      // execute rechecks admission after all preflight awaits.
      await journal.assertOwnedAdmission(handle);
      const preflight = await readReady();
      let preflightTokens: SyntheticTokens;
      try { preflightTokens = checkedTokens(await this.ports.cipher.open(preflight.envelope, this.context(expected))); }
      catch { this.quarantined = true; throw new AuthStateError("uncertain"); }
      assertValid(preflightTokens);
      return await journal.execute(handle, intent, async () => {
        try {
          const previous = await readReady();
          const tokens = checkedTokens(await this.ports.cipher.open(previous.envelope, this.context(expected)));
          const assertSame = async () => {
            const current = await readReady();
            if (JSON.stringify(current.envelope) !== JSON.stringify(previous.envelope)) fail("conflict");
          };
          assertValid(tokens);
          await assertSame();
          assertValid(tokens);
          const returned = await use(tokens.accessToken);
          // Do not let the known token values become durable receipt identifiers.
          const receiptId = returned?.receiptId;
          if (typeof receiptId !== "string" || receiptId.includes(tokens.accessToken) || receiptId.includes(tokens.refreshToken)) fail("invalid");
          await assertSame();
          return { receiptId };
        } catch { this.quarantined = true; throw new AuthStateError("uncertain"); }
      });
    } catch (error) {
      if (error instanceof AuthStateError) throw error;
      this.quarantined = true; throw new AuthStateError("uncertain");
    } finally { this.busy = false; }
  }
  async refresh(options: {
    expectedGeneration: number; journal: SingleWriterJournal; handle: RunHandle;
    operationId: string; requestDigest: string;
    exchange: (tokens: SyntheticTokens) => Promise<SyntheticRefreshResponse>;
  }): Promise<EffectReceipt> {
    if (this.quarantined) fail("uncertain");
    if (this.busy) fail("busy");
    checkGeneration(options.expectedGeneration);
    if (!sameBinding(options.handle, this.scope) || typeof options.exchange !== "function") fail("invalid");
    // Capture inputs before awaiting caller-controlled ports.
    const expected = options.expectedGeneration, handle = structuredClone(options.handle);
    const intent = { kind: "refresh" as const, targetId: this.scope.accountId, operationId: options.operationId, requestDigest: options.requestDigest };
    const exchange = options.exchange, journal = options.journal;
    this.busy = true;
    try {
      await this.transact(transaction => {
        const current = this.state(transaction);
        if (current.status === "uncertain") fail("uncertain");
        if (current.generation !== expected) fail("conflict");
      });
      return await journal.execute(handle, intent, async () => {
        try {
          // Journal intent already durable; auth reservation then fences even a
          // separately constructed adapter before decrypt/remote refresh starts.
          const previous = await this.transact(transaction => {
            if (this.quarantined) fail("uncertain");
            const current = this.state(transaction);
            if (current.status !== "ready" || current.generation !== expected) fail("conflict");
            transaction.put({ ...current, status: "uncertain" });
            return current;
          });
          const old = checkedTokens(await this.ports.cipher.open(previous.envelope, this.context(expected)));
          const response = await exchange(structuredClone(old));
          const next = checkedTokens({ accessToken: response?.accessToken, refreshToken: response?.refreshToken === undefined ? old.refreshToken : response.refreshToken, expiresAt: response?.expiresAt });
          const envelope = checkedEnvelope(await this.ports.cipher.seal(next, this.context(expected + 1)));
          await this.transact(transaction => {
            const current = this.state(transaction);
            if (current.generation !== expected || current.status !== "uncertain" || JSON.stringify(current.envelope) !== JSON.stringify(previous.envelope)) fail("conflict");
            transaction.put({ ...this.context(expected + 1), status: "ready", envelope });
          });
          return { receiptId: `dummy-auth-generation-${expected + 1}` };
        } catch { this.quarantined = true; throw new AuthStateError("uncertain"); }
      });
    } catch (error) {
      // Journal errors can originate from untrusted storage. Never expose their
      // message/cause or any provider response through this adapter.
      if (error instanceof AuthStateError) throw error;
      this.quarantined = true; throw new AuthStateError("uncertain");
    } finally { this.busy = false; }
  }
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const additionalData = (context: AuthCipherContext) => {
  checkGeneration(context.generation);
  if (context.schemaVersion !== 1) fail("invalid");
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, binding: scopeCopy(context.binding), generation: context.generation }));
};
/** Fixture-only AES-GCM implementation. Key provisioning/rotation and production
 * credential access are intentionally absent; callers supply a fixture key. */
export function createSyntheticAesGcmCipher(key: CryptoKey): SyntheticAuthCipher {
  if (key.type !== "secret" || key.algorithm.name !== "AES-GCM" || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) fail("invalid");
  return {
    async seal(tokens, context) {
      const plain = new TextEncoder().encode(JSON.stringify(checkedTokens(tokens)));
      try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(context) }, key, plain);
        return { algorithm: "AES-GCM", iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
      } catch { throw new AuthStateError("uncertain"); }
      finally { plain.fill(0); }
    },
    async open(envelope, context) {
      let bytes: Uint8Array | undefined;
      try {
        const checked = checkedEnvelope(envelope);
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(checked.iv), additionalData: additionalData(context) }, key, decode(checked.ciphertext)));
        return checkedTokens(JSON.parse(new TextDecoder().decode(bytes)));
      } catch { throw new AuthStateError("uncertain"); }
      finally { bytes?.fill(0); }
    },
  };
}
