// @verevoir/workflows/asf — a TokenProvider over ASF's access/renewal flow
// (APF-20). Matches the reference client (aigency/projects/asf-auth.mjs): an
// access token lasts about an hour; a renewal credential exchanges it for a
// fresh one at POST /api/auth/agents/renewals. The renewal credential itself
// rotates on every successful exchange, except on the grace path — a second,
// racing caller presenting the just-superseded credential within the
// server's grace window gets a fresh access token with NO new renewal
// credential, because the first caller already holds and already wrote the
// current one. Keeping the old value there, rather than discarding it, is
// what lets the second process converge onto the file the first one wrote.
//
// The credentials file is read fresh on every call, never cached in process
// memory, for the same reason: it is what a concurrent renewingToken shares.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/** Produces a bearer token on demand. */
export type TokenProvider = () => Promise<string>;

/** A fixed token, never renewed. */
export function staticToken(value: string): TokenProvider {
  return async () => value;
}

interface AsfCredentials {
  readonly token: string;
  readonly expiresAt: string;
  readonly renewalCredential: string;
  readonly renewalExpiresAt?: string;
}

export interface RenewingTokenConfig {
  readonly baseUrl: string;
  readonly credentialsFile: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Renew when fewer than this many ms of life are left — matches the
 * reference client's own 60s margin and the server's grace window. */
const RENEW_MARGIN_MS = 60_000;

function isAsfCredentials(value: unknown): value is AsfCredentials {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).token === 'string' &&
    typeof (value as Record<string, unknown>).expiresAt === 'string' &&
    typeof (value as Record<string, unknown>).renewalCredential === 'string'
  );
}

function dirnamePosix(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

async function readCredentials(path: string): Promise<AsfCredentials> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`asf credentials file not readable at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`asf credentials file at ${path} is not valid JSON`);
  }
  if (!isAsfCredentials(parsed)) {
    throw new Error(
      `asf credentials file at ${path} is missing token, expiresAt or renewalCredential`
    );
  }
  return parsed;
}

/** Writes atomically (temp file + rename) at mode 600 — a bearer credential
 * on disk, and a concurrent reader must never see a half-written file. */
async function writeCredentialsAtomic(path: string, creds: AsfCredentials): Promise<void> {
  await mkdir(dirnamePosix(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/** A TokenProvider over ASF's renewal flow — see this file's header. */
export function renewingToken(config: RenewingTokenConfig): TokenProvider {
  const { baseUrl, credentialsFile } = config;
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => Date.now());

  return async () => {
    const current = await readCredentials(credentialsFile);
    if (Date.parse(current.expiresAt) - now() > RENEW_MARGIN_MS) {
      return current.token;
    }

    const res = await doFetch(`${baseUrl}/api/auth/agents/renewals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ renewal_credential: current.renewalCredential }),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const errorBody =
        typeof body === 'object' && body !== null && 'error' in body
          ? (body as { error?: { message?: unknown } }).error
          : undefined;
      const message = typeof errorBody?.message === 'string' ? errorBody.message : res.statusText;
      // Never the request body — it carries the renewal credential.
      throw new Error(`asf renewal refused (${res.status}): ${message}`);
    }

    const out = body as {
      readonly token: string;
      readonly expiresAt: string;
      readonly renewalCredential?: string;
      readonly renewalExpiresAt?: string;
    };
    const nextRenewalExpiresAt = out.renewalExpiresAt ?? current.renewalExpiresAt;
    const next: AsfCredentials = {
      token: out.token,
      expiresAt: out.expiresAt,
      renewalCredential: out.renewalCredential ?? current.renewalCredential,
      ...(nextRenewalExpiresAt !== undefined ? { renewalExpiresAt: nextRenewalExpiresAt } : {}),
    };
    await writeCredentialsAtomic(credentialsFile, next);
    return next.token;
  };
}
