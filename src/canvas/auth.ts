import fs from "node:fs";
import { config } from "../config.js";
import type { CanvasUser } from "./types.js";

/**
 * Auth backends for the Canvas REST API. The sync engine never knows which is live.
 *
 * Priority at runtime:
 *   1. CANVAS_TOKEN env var          (personal access token — Rung 0)
 *   2. data/credentials.json         (mobile QR OAuth refresh tokens — Rung 1)
 */

export interface CanvasAuth {
  /** Headers to attach to every Canvas API request. */
  headers(): Promise<Record<string, string>>;
  /** Human-readable description of the active backend. */
  describe(): string;
}

export class TokenAuth implements CanvasAuth {
  constructor(private token: string) {}
  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.token}` };
  }
  describe(): string {
    return "personal access token";
  }
}

export interface OAuthCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO timestamp
  user?: CanvasUser;
}

export function loadOAuthCredentials(): OAuthCredentials | null {
  try {
    return JSON.parse(fs.readFileSync(config.credentialsPath, "utf8")) as OAuthCredentials;
  } catch {
    return null;
  }
}

export function saveOAuthCredentials(creds: OAuthCredentials): void {
  fs.writeFileSync(config.credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export class OAuthAuth implements CanvasAuth {
  constructor(private creds: OAuthCredentials) {}

  async headers(): Promise<Record<string, string>> {
    if (Date.parse(this.creds.expiresAt) - Date.now() < 5 * 60 * 1000) {
      await this.refresh();
    }
    return { Authorization: `Bearer ${this.creds.accessToken}` };
  }

  describe(): string {
    return "mobile QR OAuth (auto-refreshing)";
  }

  private async refresh(): Promise<void> {
    const res = await fetch(`${this.creds.baseUrl}/login/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Canvas OAuth refresh failed: ${res.status}. Re-run \`npm run auth:qr\` with a fresh QR code.`,
      );
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.creds.accessToken = data.access_token;
    this.creds.expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
    saveOAuthCredentials(this.creds);
  }
}

/** Resolves the auth backend to use, or throws with setup instructions. */
export function resolveAuth(): CanvasAuth {
  const token = process.env.CANVAS_TOKEN;
  if (token) return new TokenAuth(token);

  const creds = loadOAuthCredentials();
  if (creds) return new OAuthAuth(creds);

  throw new Error(
    "No Canvas credentials. Either set CANVAS_TOKEN in .env, or run `npm run auth:qr` " +
      "(Canvas → Account → QR for Mobile Login, decode the QR, pass the URL).",
  );
}
