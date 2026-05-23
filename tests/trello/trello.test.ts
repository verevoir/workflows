import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowApiError } from '../../src/index.js';
import {
  addComment,
  createCard,
  envFromTrelloProcessEnv,
  getCard,
  listCards,
  listColumns,
  listComments,
  moveCard,
  parseTrelloAuth,
  parseTrelloBoardUrl,
  trello,
  updateCard,
} from '../../src/trello/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENV = { token: 'myKey:myToken' };
const BOARD_URL = 'https://trello.com/b/abc123/my-board';

/** Stub global fetch to return a JSON body with status 200. */
function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// parseTrelloBoardUrl
// ---------------------------------------------------------------------------

describe('parseTrelloBoardUrl', () => {
  it('parses bare board URL', () => {
    expect(parseTrelloBoardUrl('https://trello.com/b/xK9mQ3pL')).toEqual({
      boardId: 'xK9mQ3pL',
    });
  });

  it('parses board URL with slug', () => {
    expect(parseTrelloBoardUrl('https://trello.com/b/xK9mQ3pL/my-project-board')).toEqual({
      boardId: 'xK9mQ3pL',
    });
  });

  it('returns null for an invalid URL', () => {
    expect(parseTrelloBoardUrl('https://example.com/not-trello')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTrelloAuth
// ---------------------------------------------------------------------------

describe('parseTrelloAuth', () => {
  it('splits on the first colon, preserving colons in the token', () => {
    const result = parseTrelloAuth({ token: 'key123:tok:en:with:colons' });
    expect(result).toEqual({ apiKey: 'key123', apiToken: 'tok:en:with:colons' });
  });

  it('throws WorkflowApiError when the token has no colon', () => {
    expect(() => parseTrelloAuth({ token: 'nocolontoken' })).toThrow(WorkflowApiError);
  });
});

// ---------------------------------------------------------------------------
// envFromTrelloProcessEnv
// ---------------------------------------------------------------------------

describe('envFromTrelloProcessEnv', () => {
  beforeEach(() => {
    delete process.env['TRELLO_API_KEY'];
    delete process.env['TRELLO_API_TOKEN'];
  });

  it('returns a WorkflowEnv when both vars are present', () => {
    process.env['TRELLO_API_KEY'] = 'k1';
    process.env['TRELLO_API_TOKEN'] = 't1';
    expect(envFromTrelloProcessEnv()).toEqual({ token: 'k1:t1' });
  });

  it('returns null when either var is missing', () => {
    process.env['TRELLO_API_KEY'] = 'k1';
    expect(envFromTrelloProcessEnv()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listColumns
// ---------------------------------------------------------------------------

describe('listColumns', () => {
  it('maps lists to Columns sorted by position', async () => {
    mockFetch([
      { id: 'l2', name: 'Done', pos: 200 },
      { id: 'l1', name: 'To Do', pos: 100 },
      { id: 'l3', name: 'In Progress', pos: 150 },
    ]);
    const cols = await listColumns(ENV, BOARD_URL);
    expect(cols).toEqual([
      { id: 'l1', name: 'To Do', position: 100 },
      { id: 'l3', name: 'In Progress', position: 150 },
      { id: 'l2', name: 'Done', position: 200 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// listCards
// ---------------------------------------------------------------------------

const TRELLO_CARDS = [
  {
    id: 'c1',
    name: 'Card One',
    desc: 'Some desc',
    idList: 'l1',
    idMembers: ['u1'],
    labels: [{ id: 'lb1', name: 'bug', color: 'red' }],
    due: '2026-06-01T00:00:00.000Z',
    url: 'https://trello.com/c/c1',
    dateLastActivity: '2026-05-20T10:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Card Two',
    desc: null,
    idList: 'l2',
    idMembers: ['u2'],
    labels: [{ id: 'lb2', name: 'feature', color: null }],
    due: null,
    url: 'https://trello.com/c/c2',
    dateLastActivity: '2026-05-21T10:00:00.000Z',
  },
];

describe('listCards', () => {
  it('fetches all cards and maps fields including labels and lastActivity', async () => {
    mockFetch(TRELLO_CARDS);
    const cards = await listCards(ENV, BOARD_URL);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      id: 'c1',
      title: 'Card One',
      body: 'Some desc',
      columnId: 'l1',
      assigneeIds: ['u1'],
      labels: [{ id: 'lb1', name: 'bug', color: 'red' }],
      dueDate: '2026-06-01T00:00:00.000Z',
      url: 'https://trello.com/c/c1',
      lastActivity: '2026-05-20T10:00:00.000Z',
    });
    // null desc becomes empty string
    expect(cards[1].body).toBe('');
    // null color label has no color property
    expect(cards[1].labels[0]).not.toHaveProperty('color');
  });

  it('honours columnId filter client-side', async () => {
    mockFetch(TRELLO_CARDS);
    const cards = await listCards(ENV, BOARD_URL, { columnId: 'l1' });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('c1');
  });

  it('honours assigneeId filter', async () => {
    mockFetch(TRELLO_CARDS);
    const cards = await listCards(ENV, BOARD_URL, { assigneeId: 'u2' });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('c2');
  });

  it('honours labelId filter', async () => {
    mockFetch(TRELLO_CARDS);
    const cards = await listCards(ENV, BOARD_URL, { labelId: 'lb1' });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('c1');
  });

  it('returns empty array for parentId filter — Trello is flat', async () => {
    mockFetch(TRELLO_CARDS);
    const cards = await listCards(ENV, BOARD_URL, { parentId: 'some-parent' });
    expect(cards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getCard
// ---------------------------------------------------------------------------

describe('getCard', () => {
  it('fetches a single card; null due → absent dueDate; null desc → body=""', async () => {
    mockFetch({
      id: 'c2',
      name: 'Card Two',
      desc: null,
      idList: 'l2',
      idMembers: [],
      labels: [],
      due: null,
      url: 'https://trello.com/c/c2',
      dateLastActivity: '2026-05-21T10:00:00.000Z',
    });
    const card = await getCard(ENV, BOARD_URL, 'c2');
    expect(card.id).toBe('c2');
    expect(card.body).toBe('');
    expect(card).not.toHaveProperty('dueDate');
  });

  it('throws WorkflowApiError(status=404) when card is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      })
    );
    await expect(getCard(ENV, BOARD_URL, 'missing')).rejects.toMatchObject({
      name: 'WorkflowApiError',
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// createCard
// ---------------------------------------------------------------------------

describe('createCard', () => {
  it('POSTs with idList + name; passes optional fields; returns mapped Card', async () => {
    const created = {
      id: 'cnew',
      name: 'New Card',
      desc: 'body text',
      idList: 'l1',
      idMembers: ['u1'],
      labels: [],
      due: '2026-07-01T00:00:00.000Z',
      url: 'https://trello.com/c/cnew',
      dateLastActivity: '2026-05-23T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(created),
      text: () => Promise.resolve(JSON.stringify(created)),
    });
    vi.stubGlobal('fetch', fetchMock);

    const card = await createCard(ENV, BOARD_URL, 'l1', {
      title: 'New Card',
      body: 'body text',
      assigneeIds: ['u1'],
      dueDate: '2026-07-01T00:00:00.000Z',
    });

    expect(card.id).toBe('cnew');
    expect(card.title).toBe('New Card');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/cards');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({ idList: 'l1', name: 'New Card', desc: 'body text' });
  });
});

// ---------------------------------------------------------------------------
// updateCard
// ---------------------------------------------------------------------------

describe('updateCard', () => {
  it('PUTs to /cards/<id> with correctly mapped patch fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    await updateCard(ENV, BOARD_URL, 'c1', {
      title: 'Updated',
      body: 'new desc',
      columnId: 'l2',
      assigneeIds: ['u3'],
      labelIds: ['lb2'],
      dueDate: '2026-08-01T00:00:00.000Z',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/cards/c1');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({
      name: 'Updated',
      desc: 'new desc',
      idList: 'l2',
      idMembers: ['u3'],
      idLabels: ['lb2'],
      due: '2026-08-01T00:00:00.000Z',
    });
  });

  it('throws WorkflowApiError(501) when patch.parentId is set', async () => {
    await expect(updateCard(ENV, BOARD_URL, 'c1', { parentId: 'parent1' })).rejects.toMatchObject({
      name: 'WorkflowApiError',
      status: 501,
    });
  });
});

// ---------------------------------------------------------------------------
// moveCard
// ---------------------------------------------------------------------------

describe('moveCard', () => {
  it('PUTs { idList } to /cards/<id>', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    await moveCard(ENV, BOARD_URL, 'c1', 'l3');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/cards/c1');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({ idList: 'l3' });
  });
});

// ---------------------------------------------------------------------------
// listComments
// ---------------------------------------------------------------------------

describe('listComments', () => {
  it('fetches actions and maps to Comment[] with authorName from memberCreator.fullName', async () => {
    mockFetch([
      {
        id: 'act1',
        date: '2026-05-22T09:00:00.000Z',
        data: { text: 'First comment' },
        memberCreator: { fullName: 'Alice Smith' },
      },
      {
        id: 'act2',
        date: '2026-05-23T09:00:00.000Z',
        data: { text: 'Second comment' },
        memberCreator: { fullName: 'Bob Jones' },
      },
    ]);
    const comments = await listComments(ENV, BOARD_URL, 'c1');
    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      id: 'act1',
      body: 'First comment',
      authorName: 'Alice Smith',
      date: '2026-05-22T09:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// addComment
// ---------------------------------------------------------------------------

describe('addComment', () => {
  it('POSTs { text: body } to /cards/<id>/actions/comments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    await addComment(ENV, BOARD_URL, 'c1', 'Hello board');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/cards/c1/actions/comments');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ text: 'Hello board' });
  });
});

// ---------------------------------------------------------------------------
// Aggregate export shape
// ---------------------------------------------------------------------------

describe('listCustomFields', () => {
  it('returns [] at v0 — Trello Custom Fields Power-Up not wired yet', async () => {
    const result = await trello.listCustomFields(ENV, BOARD_URL);
    expect(result).toEqual([]);
  });
});

describe('trello aggregate export', () => {
  it('has all 9 methods from the WorkflowAdapter contract', () => {
    const methods: Array<keyof typeof trello> = [
      'listColumns',
      'listCards',
      'getCard',
      'createCard',
      'updateCard',
      'moveCard',
      'listComments',
      'addComment',
      'listCustomFields',
    ];
    for (const m of methods) {
      expect(typeof trello[m]).toBe('function');
    }
  });
});
