import { rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowApiError } from '../../src/index.js';
import {
  createCard,
  envFromAsfProcessEnv,
  getCard,
  isCardFresh,
  listCards,
  listColumns,
  moveCard,
  updateCard,
} from '../../src/asf/index.js';
import { staticToken } from '../../src/asf/token.js';

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

function envWith(fetchMock: ReturnType<typeof vi.fn>) {
  return {
    token: '',
    baseUrl: 'https://example.test',
    spaceId: 'space-1',
    tokenProvider: staticToken('tok-abc'),
    fetch: fetchMock as unknown as typeof fetch,
  };
}

describe('listColumns', () => {
  it('returns the five fixed ASF columns, with no network call', async () => {
    const result = await listColumns(envWith(vi.fn()), 'ignored');
    expect(result).toEqual([
      { id: 'backlog', name: 'backlog', position: 0 },
      { id: 'ready', name: 'ready', position: 1 },
      { id: 'in-progress', name: 'in-progress', position: 2 },
      { id: 'awaiting-human-review', name: 'awaiting-human-review', position: 3 },
      { id: 'done', name: 'done', position: 4 },
    ]);
  });
});

describe('listCards', () => {
  it('maps tasks to Cards (key → readableId, revision → lastActivity)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe('https://example.test/api/spaces/space-1/tasks');
      expect(init?.headers?.authorization).toBe('Bearer tok-abc');
      return fakeResponse(200, {
        tasks: [
          {
            id: 't1',
            key: 'APF-1',
            title: 'Fix the bug',
            column: 'in-progress',
            revision: 'rev-1',
            assignee: { id: 'user-1' },
          },
        ],
      });
    });
    const result = await listCards(envWith(fetchMock), 'ignored');
    expect(result).toEqual([
      {
        id: 't1',
        readableId: 'APF-1',
        title: 'Fix the bug',
        body: '',
        columnId: 'in-progress',
        columnName: 'in-progress',
        assigneeIds: ['user-1'],
        labels: [],
        lastActivity: 'rev-1',
      },
    ]);
  });

  it('passes a columnId filter as the ?column= query param', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://example.test/api/spaces/space-1/tasks?column=done');
      return fakeResponse(200, { tasks: [] });
    });
    await listCards(envWith(fetchMock), 'ignored', { columnId: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parentId filter matches nothing, no network call', async () => {
    const fetchMock = vi.fn();
    const result = await listCards(envWith(fetchMock), 'ignored', { parentId: 'anything' });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters client-side by assigneeId and limit', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        tasks: [
          { id: 't1', key: 'APF-1', title: 'A', column: 'backlog', assignee: { id: 'u1' } },
          { id: 't2', key: 'APF-2', title: 'B', column: 'backlog', assignee: { id: 'u2' } },
          { id: 't3', key: 'APF-3', title: 'C', column: 'backlog', assignee: { id: 'u1' } },
        ],
      })
    );
    const result = await listCards(envWith(fetchMock), 'ignored', { assigneeId: 'u1', limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('t1');
  });

  it('a card with no assignee has an empty assigneeIds, not a throw', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, { tasks: [{ id: 't1', key: 'APF-1', title: 'A', column: 'backlog' }] })
    );
    const result = await listCards(envWith(fetchMock), 'ignored');
    expect(result[0]?.assigneeIds).toEqual([]);
  });
});

describe('getCard', () => {
  it('maps a found task to a Card', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://example.test/api/spaces/space-1/tasks/t1');
      return fakeResponse(200, { id: 't1', key: 'APF-1', title: 'A', column: 'backlog' });
    });
    const card = await getCard(envWith(fetchMock), 'ignored', 't1');
    expect(card.id).toBe('t1');
    expect(card.columnId).toBe('backlog');
  });

  it('a 404 throws WorkflowApiError(status=404)', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(404, { error: { code: 'NOT_FOUND', message: 'Task not found' } })
    );
    await expect(getCard(envWith(fetchMock), 'ignored', 'missing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a non-404 failure throws WorkflowApiError naming the server message', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(503, { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'store unavailable' } })
    );
    await expect(getCard(envWith(fetchMock), 'ignored', 't1')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('store unavailable'),
    });
  });

  it('throws a named refusal when env is missing baseUrl/spaceId/tokenProvider', async () => {
    const bare = { token: '' };
    await expect(getCard(bare, 'ignored', 't1')).rejects.toBeInstanceOf(WorkflowApiError);
  });
});

describe('isCardFresh', () => {
  it('true when revision matches the held version', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-1',
      })
    );
    expect(await isCardFresh(envWith(fetchMock), 'ignored', 't1', 'rev-1')).toBe(true);
  });

  it('false when revision has moved on', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-2',
      })
    );
    expect(await isCardFresh(envWith(fetchMock), 'ignored', 't1', 'rev-1')).toBe(false);
  });

  it('false, not a throw, when the card is gone (404)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(404, { error: { message: 'gone' } }));
    expect(await isCardFresh(envWith(fetchMock), 'ignored', 't1', 'rev-1')).toBe(false);
  });
});

describe('envFromAsfProcessEnv', () => {
  const keys = [
    'ASF_PLATFORM_BASE_URL',
    'ASF_SPACE_ID',
    'ASF_TOKEN',
    'ASF_CREDENTIALS_FILE',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    while (tmpFiles.length > 0) {
      const f = tmpFiles.pop();
      if (f !== undefined) await rm(f, { force: true });
    }
  });

  function setEnv(values: Partial<Record<(typeof keys)[number], string>>): void {
    for (const key of keys) {
      saved[key] = process.env[key];
      if (values[key] !== undefined) process.env[key] = values[key];
      else delete process.env[key];
    }
  }

  it('returns null when baseUrl or spaceId is absent', () => {
    setEnv({ ASF_TOKEN: 'tok' });
    expect(envFromAsfProcessEnv()).toBeNull();
  });

  it('returns null when neither ASF_TOKEN nor ASF_CREDENTIALS_FILE is set', () => {
    setEnv({ ASF_PLATFORM_BASE_URL: 'https://example.test', ASF_SPACE_ID: 'space-1' });
    expect(envFromAsfProcessEnv()).toBeNull();
  });

  it('builds a static-token AsfEnv when ASF_TOKEN is set', async () => {
    setEnv({
      ASF_PLATFORM_BASE_URL: 'https://example.test',
      ASF_SPACE_ID: 'space-1',
      ASF_TOKEN: 'fixed-tok',
    });
    const env = envFromAsfProcessEnv();
    expect(env).not.toBeNull();
    expect(env?.baseUrl).toBe('https://example.test');
    expect(env?.spaceId).toBe('space-1');
    expect(await env?.tokenProvider()).toBe('fixed-tok');
  });

  it('renewing-token env when ASF_CREDENTIALS_FILE is set', async () => {
    const path = `/tmp/asf-env-test-${Date.now()}.json`;
    tmpFiles.push(path);
    await writeFile(
      path,
      JSON.stringify({
        token: 'from-file',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        renewalCredential: 'renewal-abc',
      }),
      { mode: 0o600 }
    );
    setEnv({
      ASF_PLATFORM_BASE_URL: 'https://example.test',
      ASF_SPACE_ID: 'space-1',
      ASF_CREDENTIALS_FILE: path,
    });
    const env = envFromAsfProcessEnv();
    expect(env).not.toBeNull();
    expect(await env?.tokenProvider()).toBe('from-file');
  });

  it('prefers ASF_TOKEN over ASF_CREDENTIALS_FILE when both are set', async () => {
    setEnv({
      ASF_PLATFORM_BASE_URL: 'https://example.test',
      ASF_SPACE_ID: 'space-1',
      ASF_TOKEN: 'fixed-tok',
      ASF_CREDENTIALS_FILE: '/tmp/does-not-matter-does-not-get-read.json',
    });
    const env = envFromAsfProcessEnv();
    expect(await env?.tokenProvider()).toBe('fixed-tok');
  });
});

describe('createCard', () => {
  it('refuses with a named 501 — ASF has no create route, no network call', async () => {
    const fetchMock = vi.fn();
    await expect(
      createCard(envWith(fetchMock), 'ignored', 'backlog', { title: 'New task' })
    ).rejects.toMatchObject({ status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('updateCard', () => {
  it('refuses with a named 501 — ASF has no generic update route, no network call', async () => {
    const fetchMock = vi.fn();
    await expect(
      updateCard(envWith(fetchMock), 'ignored', 't1', { title: 'Renamed' })
    ).rejects.toMatchObject({ status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('moveCard', () => {
  it('reads the current revision, then POSTs the move conditioned on it', async () => {
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, init });
      if (init?.method === 'POST') {
        return fakeResponse(200, {
          id: 't1',
          key: 'APF-1',
          title: 'A',
          column: 'ready',
          revision: 'rev-2',
        });
      }
      return fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-1',
      });
    });
    await moveCard(envWith(fetchMock), 'ignored', 't1', 'ready');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://example.test/api/spaces/space-1/tasks/t1');
    expect(calls[1]?.url).toBe('https://example.test/api/spaces/space-1/tasks/t1/moves');
    expect(JSON.parse(calls[1]?.init?.body ?? '{}')).toEqual({
      column: 'ready',
      expectedRevision: 'rev-1',
    });
  });

  it('a revision conflict (racing move) is refetched and retried, then succeeds', async () => {
    let postAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        postAttempts += 1;
        if (postAttempts === 1) {
          return fakeResponse(409, {
            error: {
              code: 'CONFLICT',
              message: 'The task changed since it was read; reload and try again',
            },
          });
        }
        return fakeResponse(200, {
          id: 't1',
          key: 'APF-1',
          title: 'A',
          column: 'ready',
          revision: 'rev-2',
        });
      }
      return fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-1',
      });
    });
    await moveCard(envWith(fetchMock), 'ignored', 't1', 'ready');
    expect(postAttempts).toBe(2);
    // 2 GETs (one per attempt) + 2 POSTs (one conflict, one success) — proves a
    // real refetch happened between attempts, not a blind retry of the same POST.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a revision conflict that never clears exhausts retries and throws a named 409', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return fakeResponse(409, {
          error: {
            code: 'CONFLICT',
            message: 'The task changed since it was read; reload and try again',
          },
        });
      }
      return fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-1',
      });
    });
    await expect(moveCard(envWith(fetchMock), 'ignored', 't1', 'ready')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('after 3 attempts'),
    });
    // 3 GETs + 3 POSTs — exactly the bound, never more.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('an archived-task 409 is not retried; it throws that conflict immediately, not the retry-exhausted one', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return fakeResponse(409, {
          error: {
            code: 'CONFLICT',
            message: 'The task is archived; unarchive it before moving it',
            details: { reason: 'archived' },
          },
        });
      }
      return fakeResponse(200, {
        id: 't1',
        key: 'APF-1',
        title: 'A',
        column: 'backlog',
        revision: 'rev-1',
      });
    });
    await expect(moveCard(envWith(fetchMock), 'ignored', 't1', 'ready')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('archived'),
    });
    // Exactly one GET + one POST — no retry loop for an archived conflict.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
