import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renewingToken, staticToken } from '../../src/asf/token.js';

function tmpCredentialsPath(): string {
  return `/tmp/asf-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

async function writeCreds(path: string, creds: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(creds), { mode: 0o600 });
}

function fakeResponse(
  status: number,
  body: unknown
): { ok: boolean; status: number; statusText: string; text: () => Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  };
}

describe('staticToken', () => {
  it('returns the given value every call, unchanged', async () => {
    const provider = staticToken('fixed-value');
    expect(await provider()).toBe('fixed-value');
    expect(await provider()).toBe('fixed-value');
  });
});

describe('renewingToken', () => {
  const paths: string[] = [];

  afterEach(async () => {
    while (paths.length > 0) {
      const path = paths.pop();
      if (path !== undefined) await rm(path, { force: true });
    }
  });

  it('returns the cached token when it has more than 60s left, without calling fetch', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'cached-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      renewalCredential: 'renewal-abc',
    });
    const fetchMock = vi.fn();
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await provider()).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renews on the rotated path: posts the renewal credential, returns the new token, and rewrites the file with the NEW renewal credential', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'stale-token',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      renewalCredential: 'renewal-old',
      renewalExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(url).toBe('https://example.test/api/auth/agents/renewals');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({ renewal_credential: 'renewal-old' });
      return fakeResponse(200, {
        token: 'fresh-token',
        expiresAt: '2026-06-01T00:00:00.000Z',
        renewalCredential: 'renewal-new',
        renewalExpiresAt: '2027-01-01T00:00:00.000Z',
      });
    });
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await provider()).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toEqual({
      token: 'fresh-token',
      expiresAt: '2026-06-01T00:00:00.000Z',
      renewalCredential: 'renewal-new',
      renewalExpiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('renews on the grace path: the response omits renewalCredential and renewalExpiresAt, and the OLD values are kept on disk', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'stale-token',
      expiresAt: new Date(Date.now()).toISOString(),
      renewalCredential: 'renewal-held-by-first-caller',
      renewalExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, { token: 'fresh-token-grace', expiresAt: '2026-06-01T00:00:00.000Z' })
    );
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await provider()).toBe('fresh-token-grace');
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toEqual({
      token: 'fresh-token-grace',
      expiresAt: '2026-06-01T00:00:00.000Z',
      renewalCredential: 'renewal-held-by-first-caller',
      renewalExpiresAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('writes the credentials file at mode 600', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'stale-token',
      expiresAt: new Date(Date.now()).toISOString(),
      renewalCredential: 'renewal-old',
    });
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        token: 'fresh-token',
        expiresAt: '2026-06-01T00:00:00.000Z',
        renewalCredential: 'renewal-new',
      })
    );
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await provider();
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('throws naming the server-stated reason on a refused renewal, never a token value', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'stale-token',
      expiresAt: new Date(Date.now()).toISOString(),
      renewalCredential: 'renewal-unknown-to-server',
    });
    const fetchMock = vi.fn(async () =>
      fakeResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Renewal credential not found or revoked' },
      })
    );
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider()).rejects.toThrow('Renewal credential not found or revoked');
  });

  it('uses the injected now() to decide freshness, not the real clock', async () => {
    const path = tmpCredentialsPath();
    paths.push(path);
    await writeCreds(path, {
      token: 'cached-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      renewalCredential: 'renewal-old',
    });
    const fetchMock = vi.fn();
    const provider = renewingToken({
      baseUrl: 'https://example.test',
      credentialsFile: path,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => Date.parse('2031-01-01T00:00:00.000Z'),
    });
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        token: 'renewed-because-now-says-expired',
        expiresAt: '2032-01-01T00:00:00.000Z',
        renewalCredential: 'renewal-new',
      })
    );

    expect(await provider()).toBe('renewed-because-now-says-expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
