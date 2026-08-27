import type { OAuthCredentials } from "./auth.js";

/**
 * Canvas mobile QR login flow — mirrors the canvas-ios reference implementation.
 *
 * 1. The QR encodes: https://sso.canvaslms.com/canvas/login?domain=<host>&code=<one-time>
 * 2. GET /api/v1/mobile_verify.json hands out the mobile client_id/client_secret for that domain.
 * 3. POST /login/oauth2/token (authorization_code grant) trades the code for access+refresh tokens.
 *
 * Run via `npm run auth:qr "<decoded QR URL>"`.
 * The QR is valid 10 minutes and the code is one-shot.
 */

const SSO_HOSTS = ["sso.canvaslms.com", "sso.beta.canvaslms.com", "sso.test.canvaslms.com"];

export interface ParsedQr {
  ssoHost: string;
  domain: string;
  code: string;
}

export function parseQrLoginUrl(qrUrl: string): ParsedQr {
  let url: URL;
  try {
    url = new URL(qrUrl.trim());
  } catch {
    throw new Error(`Not a valid URL: ${qrUrl}`);
  }
  if (!SSO_HOSTS.includes(url.hostname)) {
    throw new Error(`Unrecognized SSO host '${url.hostname}'; expected one of ${SSO_HOSTS.join(", ")}`);
  }
  if (url.pathname !== "/canvas/login") {
    throw new Error(`Expected path /canvas/login, got '${url.pathname}'`);
  }
  const domain = url.searchParams.get("domain");
  const code = url.searchParams.get("code");
  if (!domain) throw new Error("QR URL is missing 'domain' query parameter");
  if (!code) throw new Error("QR URL is missing 'code' query parameter");
  return {
    ssoHost: url.hostname,
    domain: domain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    code,
  };
}

async function fetchMobileClient(domain: string, ssoHost: string) {
  const res = await fetch(`https://${ssoHost}/api/v1/mobile_verify.json?domain=${encodeURIComponent(domain)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`mobile_verify failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    authorized?: boolean;
    base_url?: string;
    client_id?: string;
    client_secret?: string;
  };
  if (data.authorized !== true) throw new Error(`Mobile logins not authorized for domain '${domain}'`);
  if (!data.base_url || !data.client_id || !data.client_secret) {
    throw new Error(`mobile_verify response incomplete: ${JSON.stringify(Object.keys(data))}`);
  }
  return { baseUrl: data.base_url.replace(/\/$/, ""), clientId: data.client_id, clientSecret: data.client_secret };
}

export async function qrLogin(qrUrl: string): Promise<OAuthCredentials> {
  const parsed = parseQrLoginUrl(qrUrl);
  const client = await fetchMobileClient(parsed.domain, parsed.ssoHost);

  const res = await fetch(`${client.baseUrl}/login/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "authorization_code",
      code: parsed.code,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} — QR codes are one-shot and expire in 10 minutes.`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id: number; name?: string };
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token response missing access_token or refresh_token");
  }

  return {
    baseUrl: client.baseUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    user: data.user,
  };
}
