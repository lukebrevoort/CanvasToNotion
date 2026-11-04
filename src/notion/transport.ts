export type NotionRequestEvent = Readonly<{
  operation: "notion_request";
  sequence: number;
  kind: "read" | "write";
  phase: "started" | "settled";
  result?: "fulfilled" | "rejected";
  elapsedMs?: number;
  status?: number;
}>;

/** POST queries are reads. Unknown endpoints remain conservatively classified as writes. */
export function isNotionRead(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.notion.com" || url.username || url.password) return false;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") return url.pathname.startsWith("/v1/");
  // The query endpoint is read-only regardless of its filter/pagination payload.
  const id = "(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})";
  return method === "POST" && !url.search && new RegExp(`^/v1/(?:data_sources|databases)/${id}/query$`, "i").test(url.pathname);
}

/** No retries. Read deadlines cover connection, headers AND response body.
 * Writes retain their caller's signal and are never given a new abort deadline.
 * One transport admits only one request until its complete body settles, even
 * when an outer SDK timeout has already rejected. This is a per-client local
 * guard, not a persistent lock or a fence against restarts/external writers.
 * A rejected write can have committed remotely; callers must not blindly retry.
 * Telemetry contains only local sequence, fixed enums and elapsed time, never
 * request/response data. A telemetry callback failure propagates conservatively.
 */
export function createNotionTransport({
  fetch: delegate = globalThis.fetch,
  readTimeoutMs = 25_000,
  onEvent,
}: {
  fetch?: typeof fetch;
  readTimeoutMs?: number;
  onEvent?: (event: NotionRequestEvent) => void;
} = {}): typeof fetch {
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) throw new Error("Invalid Notion read deadline");
  let sequence = 0;
  let pending = false;
  return async (input, init) => {
    if (pending) throw new Error("Previous Notion transport request is still unsettled");
    const kind = isNotionRead(input, init) ? "read" : "write";
    const current = ++sequence, start = performance.now();
    pending = true;
    try {
      onEvent?.(Object.freeze({ operation: "notion_request", sequence: current, kind, phase: "started" }));
    } catch (error) {
      pending = false;
      throw error;
    }
    let status: number | undefined;
    let settled = false;
    try {
      const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const deadline = kind === "read" ? AbortSignal.timeout(readTimeoutMs) : undefined;
      const signal = deadline ? (originalSignal ? AbortSignal.any([originalSignal, deadline]) : deadline) : originalSignal;
      const response = await delegate(input, { ...init, ...(signal ? { signal } : {}), redirect: "error" });
      status = response.status;
      // Do not report settlement when only headers have arrived. The SDK's own
      // timeout races a promise; it does not abort this transport or its body.
      const body = await response.arrayBuffer();
      const buffered = new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
      settled = true;
      onEvent?.(Object.freeze({ operation: "notion_request", sequence: current, kind, phase: "settled", result: "fulfilled", status, elapsedMs: Math.floor(performance.now() - start) }));
      return buffered;
    } catch (error) {
      if (!settled) onEvent?.(Object.freeze({ operation: "notion_request", sequence: current, kind, phase: "settled", result: "rejected", ...(status !== undefined ? { status } : {}), elapsedMs: Math.floor(performance.now() - start) }));
      throw error;
    } finally {
      pending = false;
    }
  };
}
