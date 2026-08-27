import type { CanvasAuth } from "./auth.js";

/**
 * Typed Canvas REST client. Handles pagination (Link headers), 429 rate-limit
 * backoff, and retries on transient errors.
 */

const SSO_HOSTS = ["sso.canvaslms.com", "sso.beta.canvaslms.com", "sso.test.canvaslms.com"];

export class CanvasClient {
  constructor(
    private domain: string,
    private auth: CanvasAuth,
  ) {}

  get baseUrl(): string {
    return `https://${this.domain}/api/v1`;
  }

  private async request<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...(await this.auth.headers()) },
      });

      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get("x-rate-limit-remaining") ?? 2);
        await sleep(retryAfter * 1000 || 2000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Canvas ${res.status} ${res.statusText} for ${path}: ${(await res.text()).slice(0, 300)}`);
      }
      return (await res.json()) as T;
    }
  }

  /** Iterates all pages of a list endpoint via RFC 5988 Link headers. */
  private async *paginate<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): AsyncGenerator<T> {
    let url: URL | null = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    while (url) {
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...(await this.auth.headers()) },
      });
      if (!res.ok) {
        throw new Error(`Canvas ${res.status} ${res.statusText} for ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
      }
      for (const item of (await res.json()) as T[]) yield item;
      url = nextLink(res.headers.get("link"));
      // Be polite between pages.
      if (url) await sleep(150);
    }
  }

  me(): Promise<{ id: number; name?: string }> {
    return this.request("/users/self");
  }

  courses(enrollmentState: "active" | "invited_or_pending" = "active") {
    return this.paginate<import("./types.js").CanvasCourse>("/courses", {
      enrollment_state: enrollmentState,
      include: "term",
    });
  }

  assignments(courseId: number, updatedSince?: Date) {
    const params: Record<string, string | number | undefined> = {
      order_by: "due_at",
      per_page: 100,
      include: "submission",
      all_dates: "true",
    };
    if (updatedSince) params["updated_since"] = updatedSince.toISOString();
    return this.paginate<import("./types.js").CanvasAssignment>(`/courses/${courseId}/assignments`, params);
  }

  assignmentGroups(courseId: number) {
    return this.paginate<import("./types.js").CanvasAssignmentGroup>(
      `/courses/${courseId}/assignment_groups`,
      { per_page: 100 },
    );
  }

  submission(courseId: number, assignmentId: number, userId: number) {
    return this.request<import("./types.js").CanvasSubmission>(
      `/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      { include: ["visibility"] as unknown as string },
    );
  }

  /** Validates credentials; returns the authenticated user. */
  async verify(): Promise<{ auth: string; user: { id: number; name?: string } }> {
    const user = await this.me();
    return { auth: this.auth.describe(), user };
  }
}

function nextLink(header: string | null): URL | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const [rawUrl, ...params] = part.split(";");
    if (rawUrl && params.some((p) => p.trim() === 'rel="next"')) {
      return new URL(rawUrl.trim().replace(/^<|>$/g, ""));
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { SSO_HOSTS };
