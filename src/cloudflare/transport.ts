/** Synthetic-only, injected Worker-compatible JSON transport. No provider auth,
 * production origins, retries, scheduling or implicit redirect following.
 * Injected fetch must await its work and honor ordinary Fetch contracts. Abort
 * is not proof of cancellation: unsettled work stays tracked after timeout.
 */
export type SyntheticOrigin = "https://canvas.invalid" | "https://notion.invalid";
export type OperationKind = "read" | "write";
export type TransportErrorCode = "invalid" | "busy" | "budget" | "uncertain" | "timeout" | "aborted" | "redirect" | "response" | "body_limit" | "transport";
export class SyntheticTransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly operationKind: OperationKind | null = null, readonly status?: number) {
    super(`Synthetic transport: ${code}`); this.name = "SyntheticTransportError";
  }
}
export interface SyntheticJsonRequest {
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";
  json?: unknown;
  notionVersion?: "2025-09-03";
  signal?: AbortSignal;
}
export interface SyntheticTransportOptions {
  syntheticOnly: true;
  origin: SyntheticOrigin;
  fetch: typeof fetch;
  requestBudget: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
const failure = (code: TransportErrorCode, kind: OperationKind | null = null, status?: number) => new SyntheticTransportError(code, kind, status);

export class SyntheticJsonTransport {
  private readonly origin: SyntheticOrigin;
  private readonly fetchPort: typeof fetch;
  private readonly budget: number;
  private readonly timeout: number;
  private readonly limit: number;
  private used = 0;
  private active = 0;
  private uncertain = false;
  private lastOperationKind: OperationKind | null = null;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: SyntheticTransportOptions) {
    const timeout = options.timeoutMs ?? 25_000, limit = options.maxResponseBytes ?? 65_536;
    if (options.syntheticOnly !== true || !["https://canvas.invalid", "https://notion.invalid"].includes(options.origin) ||
        typeof options.fetch !== "function" || !Number.isSafeInteger(options.requestBudget) || options.requestBudget < 1 || options.requestBudget > 50 ||
        !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 25_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_048_576) throw failure("invalid");
    this.origin = options.origin; this.fetchPort = options.fetch; this.budget = options.requestBudget; this.timeout = timeout; this.limit = limit;
  }
  state() { return { used: this.used, active: this.active, uncertain: this.uncertain, lastOperationKind: this.lastOperationKind }; }
  /** No timeout/cancellation fiction here. Can remain pending indefinitely. */
  async settleStartedRequests(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  async request(request: SyntheticJsonRequest): Promise<unknown> {
    return (await this.requestDetailed(request)).json;
  }
  /** Only pagination Link is exposed; never arbitrary response headers. */
  async requestDetailed(request: SyntheticJsonRequest): Promise<{ json: unknown; link: string | null }> {
    if (this.uncertain) throw failure("uncertain");
    if (this.active) throw failure("busy");
    let url: URL;
    try { url = new URL(request.url); } catch { throw failure("invalid"); }
    const method = request.method ?? "GET";
    if (url.origin !== this.origin || url.username || url.password || url.hash ||
        !["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(method) ||
        (["GET", "HEAD"].includes(method) && request.json !== undefined) ||
        (request.notionVersion !== undefined && (this.origin !== "https://notion.invalid" || request.notionVersion !== "2025-09-03"))) throw failure("invalid");
    // Conservative: even a POST query is a write unless a separate reviewed
    // endpoint classifier proves otherwise. This never authorizes retries.
    const kind: OperationKind = method === "GET" || method === "HEAD" ? "read" : "write";
    if (request.signal?.aborted) throw failure("aborted", kind);
    if (this.used >= this.budget) throw failure("budget", kind);
    let body: string | undefined;
    try {
      if (request.json !== undefined) {
        body = JSON.stringify(request.json);
        if (body === undefined || new TextEncoder().encode(body).byteLength > 65_536) throw failure("invalid");
      }
    } catch { throw failure("invalid", kind); }
    const signal = request.signal;
    const notionVersion = request.notionVersion;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let completedBody = false;
    let dispatched = false;
    const deadline = performance.now() + this.timeout;
    let abortCode: "timeout" | "aborted" | undefined;
    let rejectAbort!: (error: SyntheticTransportError) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancelReader = () => {
      if (reader && !cancellation) {
        try { cancellation = Promise.resolve(reader.cancel()).then(() => undefined, () => undefined); }
        catch { cancellation = Promise.resolve(); }
      }
    };
    const abort = (code: "timeout" | "aborted") => {
      if (abortCode) return;
      abortCode = code; if (dispatched) this.uncertain = true;
      controller.abort(); cancelReader(); rejectAbort(failure(code, kind));
    };
    const checkDeadline = () => {
      if (performance.now() >= deadline) abort("timeout");
      if (controller.signal.aborted) throw failure(abortCode ?? "aborted", kind);
    };
    const callerAbort = () => abort("aborted");
    signal?.addEventListener("abort", callerAbort, { once: true });
    const timer = setTimeout(() => abort("timeout"), this.timeout);
    this.active = 1; this.lastOperationKind = kind;
    const work = Promise.resolve().then(async () => {
      try {
        if (signal?.aborted) abort("aborted");
        checkDeadline();
        this.used++; dispatched = true;
        const response = await this.fetchPort(url.href, {
          method, body, headers: body === undefined && notionVersion === undefined ? undefined : { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(notionVersion === undefined ? {} : { "Notion-Version": notionVersion }) },
          redirect: "manual", credentials: "omit", signal: controller.signal,
        });
        if (response.body) reader = response.body.getReader();
        checkDeadline();
        if (response.redirected || response.status >= 300 && response.status < 400) throw failure("redirect", kind, response.status);
        if (!response.ok) throw failure("response", kind, response.status);
        const link = response.headers.get("Link");
        if (link !== null && (new TextEncoder().encode(link).byteLength > 8192 || /[\r\n]/.test(link))) throw failure("response", kind);
        const chunks: Uint8Array[] = []; let size = 0;
        if (reader) {
          while (true) {
            const part = await reader.read();
            checkDeadline();
            if (part.done) { completedBody = true; break; }
            if (!(part.value instanceof Uint8Array)) throw failure("response", kind);
            size += part.value.byteLength;
            if (size > this.limit) throw failure("body_limit", kind);
            chunks.push(part.value.slice());
          }
        } else completedBody = true;
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw failure("response", kind); }
        checkDeadline(); return { json: parsed, link };
      } catch (error) {
        if (dispatched) this.uncertain = true;
        // Never propagate payloads, URLs, provider errors or cancellation reasons.
        throw error instanceof SyntheticTransportError ? failure(error.code, kind, error.status) : failure("transport", kind);
      } finally {
        if (!completedBody) cancelReader();
        if (cancellation) await cancellation;
        try { reader?.releaseLock(); } catch { /* Never expose stream errors. */ }
      }
    });
    this.pending.add(work);
    void work.then(() => { this.active = 0; this.pending.delete(work); }, () => { this.active = 0; this.pending.delete(work); });
    try { return await Promise.race([work, aborted]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", callerAbort); }
  }
}
