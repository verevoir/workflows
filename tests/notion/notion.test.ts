import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseNotionDatabaseUrl, envFromNotionProcessEnv } from '../../src/notion/index.js';
import { WorkflowApiError, type WorkflowEnv } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe('parseNotionDatabaseUrl', () => {
  const DASHED = 'aabbccdd-1122-3344-5566-77889900aabb';
  const RAW = 'aabbccdd11223344556677889900aabb';

  it('extracts database IDs from canonical workspace URLs with view params', () => {
    expect(
      parseNotionDatabaseUrl(`https://www.notion.so/myws/${RAW}?v=ffeeddccbbaa99887766554433221100`)
    ).toEqual({ databaseId: DASHED });
  });

  it('dashifies 32-hex raw IDs', () => {
    expect(parseNotionDatabaseUrl(RAW)).toEqual({ databaseId: DASHED });
  });

  it('passes dashed UUIDs through (already canonical)', () => {
    expect(parseNotionDatabaseUrl(DASHED)).toEqual({ databaseId: DASHED });
  });

  it('passes other non-numeric inputs through as-is — SDK rejects bad IDs at call time', () => {
    // Examples of inputs we deliberately do NOT format-check: STDIO-shaped
    // prefixes, mixed-case identifiers, unusual notion-side conventions.
    expect(parseNotionDatabaseUrl('STDIO-42')).toEqual({ databaseId: 'STDIO-42' });
    expect(parseNotionDatabaseUrl('some-custom-id')).toEqual({ databaseId: 'some-custom-id' });
  });

  it('returns null for empty or purely-numeric inputs', () => {
    expect(parseNotionDatabaseUrl('')).toBeNull();
    expect(parseNotionDatabaseUrl('   ')).toBeNull();
    expect(parseNotionDatabaseUrl('12345')).toBeNull();
  });
});

describe('envFromNotionProcessEnv', () => {
  beforeEach(() => {
    delete process.env['NOTION_API_KEY'];
  });

  it('returns a WorkflowEnv when NOTION_API_KEY is set', () => {
    process.env['NOTION_API_KEY'] = 'ntn_test';
    expect(envFromNotionProcessEnv()).toEqual({ token: 'ntn_test' });
  });

  it('returns null when NOTION_API_KEY is missing', () => {
    expect(envFromNotionProcessEnv()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SDK-mocked tests
// ---------------------------------------------------------------------------

vi.mock('@notionhq/client', async () => {
  const actual = await vi.importActual<typeof import('@notionhq/client')>('@notionhq/client');
  function MockClient(this: unknown, _options: unknown) {
    return clientStub;
  }
  return {
    ...actual,
    Client: MockClient,
  };
});

interface ClientStub {
  databases: { retrieve: ReturnType<typeof vi.fn> };
  dataSources: {
    retrieve: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  pages: {
    retrieve: ReturnType<typeof vi.fn>;
    retrieveMarkdown: ReturnType<typeof vi.fn>;
    updateMarkdown: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  comments: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

let clientStub: ClientStub;

beforeEach(() => {
  clientStub = {
    databases: { retrieve: vi.fn() },
    dataSources: { retrieve: vi.fn(), query: vi.fn() },
    pages: {
      retrieve: vi.fn(),
      retrieveMarkdown: vi.fn(),
      updateMarkdown: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    comments: { list: vi.fn(), create: vi.fn() },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENV: WorkflowEnv = { token: 'ntn_test_token' };
const DB_URL = 'https://www.notion.so/myws/aabbccdd11223344556677889900aabb?v=ffee';
const DB_ID = 'aabbccdd-1122-3344-5566-77889900aabb';
const DS_ID = '11112222-3333-4444-5555-666677778888';

/** Standard schema response: title + Status (status) + Assignee (people) + Tags (multi_select) */
function schemaResponse() {
  return {
    object: 'data_source',
    id: DS_ID,
    properties: {
      Title: { id: 'p_title', name: 'Title', type: 'title', title: {} },
      Status: {
        id: 'p_status',
        name: 'Status',
        type: 'status',
        status: {
          options: [
            { id: 'col-todo', name: 'Todo', color: 'gray' },
            { id: 'col-doing', name: 'Doing', color: 'blue' },
            { id: 'col-done', name: 'Done', color: 'green' },
          ],
        },
      },
      Assignee: { id: 'p_people', name: 'Assignee', type: 'people', people: {} },
      Tags: {
        id: 'p_tags',
        name: 'Tags',
        type: 'multi_select',
        multi_select: {
          options: [
            { id: 'lbl-bug', name: 'bug', color: 'red' },
            { id: 'lbl-feat', name: 'feature', color: 'green' },
          ],
        },
      },
    },
  };
}

function dbWithDataSource() {
  return { object: 'database', id: DB_ID, data_sources: [{ id: DS_ID, name: 'Cards' }] };
}

function fullPageRow(
  id: string,
  opts: {
    title?: string;
    statusOption?: { id: string; name: string };
    assignees?: string[];
    labels?: Array<{ id: string; name: string; color?: string }>;
    lastEditedTime?: string;
  }
) {
  return {
    object: 'page',
    id,
    created_time: '2026-05-24T10:00:00.000Z',
    last_edited_time: opts.lastEditedTime ?? '2026-05-24T11:00:00.000Z',
    parent: { type: 'data_source_id', data_source_id: DS_ID },
    archived: false,
    in_trash: false,
    url: `https://notion.so/${id}`,
    public_url: null,
    cover: null,
    icon: null,
    created_by: { object: 'user', id: 'u-creator' },
    last_edited_by: { object: 'user', id: 'u-creator' },
    properties: {
      Title: {
        id: 'p_title',
        type: 'title',
        title: opts.title
          ? [{ type: 'text', plain_text: opts.title, text: { content: opts.title, link: null } }]
          : [],
      },
      Status: {
        id: 'p_status',
        type: 'status',
        status: opts.statusOption ?? null,
      },
      Assignee: {
        id: 'p_people',
        type: 'people',
        people: (opts.assignees ?? []).map((id) => ({ id, object: 'user' })),
      },
      Tags: {
        id: 'p_tags',
        type: 'multi_select',
        multi_select: opts.labels ?? [],
      },
    },
  };
}

describe('listColumns', () => {
  it('returns the status property options as Columns', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    const { listColumns } = await import('../../src/notion/index.js');
    const cols = await listColumns(ENV, DB_URL);
    expect(cols).toEqual([
      { id: 'col-todo', name: 'Todo', position: 0 },
      { id: 'col-doing', name: 'Doing', position: 1 },
      { id: 'col-done', name: 'Done', position: 2 },
    ]);
  });

  it('returns [] when the data source has no status/select property', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue({
      ...schemaResponse(),
      properties: { Title: { id: 'p_title', name: 'Title', type: 'title', title: {} } },
    });
    const { listColumns } = await import('../../src/notion/index.js');
    await expect(listColumns(ENV, DB_URL)).resolves.toEqual([]);
  });
});

describe('listCards', () => {
  it('maps rows to Cards including body via retrieveMarkdown', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.dataSources.query.mockResolvedValue({
      results: [
        fullPageRow('row-1', {
          title: 'First card',
          statusOption: { id: 'col-todo', name: 'Todo' },
          assignees: ['u-1'],
          labels: [{ id: 'lbl-bug', name: 'bug', color: 'red' }],
        }),
      ],
      has_more: false,
      next_cursor: null,
    });
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: 'Body of first card' });

    const { listCards } = await import('../../src/notion/index.js');
    const cards = await listCards(ENV, DB_URL);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'row-1',
      title: 'First card',
      body: 'Body of first card',
      columnId: 'col-todo',
      columnName: 'Todo',
      assigneeIds: ['u-1'],
      labels: [{ id: 'lbl-bug', name: 'bug', color: 'red' }],
      lastActivity: '2026-05-24T11:00:00.000Z',
    });
  });

  it('skips per-row body fetches when includeBody is false, and caps with limit', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.dataSources.query.mockResolvedValue({
      results: [
        fullPageRow('row-1', { title: 'A', statusOption: { id: 'col-todo', name: 'Todo' } }),
        fullPageRow('row-2', { title: 'B', statusOption: { id: 'col-todo', name: 'Todo' } }),
        fullPageRow('row-3', { title: 'C', statusOption: { id: 'col-todo', name: 'Todo' } }),
      ],
      has_more: false,
      next_cursor: null,
    });

    const { listCards } = await import('../../src/notion/index.js');
    const cards = await listCards(ENV, DB_URL, { includeBody: false, limit: 2 });

    expect(cards).toHaveLength(2); // limit applied after mapping
    expect(cards.every((c) => c.body === '')).toBe(true); // bodies omitted
    // the expensive part — one retrieveMarkdown per row — is skipped entirely
    expect(clientStub.pages.retrieveMarkdown).not.toHaveBeenCalled();
  });

  it('honours columnId, assigneeId, labelId, parentId filters', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.dataSources.query.mockResolvedValue({
      results: [
        fullPageRow('row-1', {
          title: 'A',
          statusOption: { id: 'col-todo', name: 'Todo' },
          assignees: ['u-1'],
          labels: [{ id: 'lbl-bug', name: 'bug' }],
        }),
        fullPageRow('row-2', {
          title: 'B',
          statusOption: { id: 'col-done', name: 'Done' },
          assignees: ['u-2'],
          labels: [{ id: 'lbl-feat', name: 'feature' }],
        }),
      ],
      has_more: false,
      next_cursor: null,
    });
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });

    const { listCards } = await import('../../src/notion/index.js');
    const todo = await listCards(ENV, DB_URL, { columnId: 'col-todo' });
    expect(todo.map((c) => c.id)).toEqual(['row-1']);

    const u2 = await listCards(ENV, DB_URL, { assigneeId: 'u-2' });
    expect(u2.map((c) => c.id)).toEqual(['row-2']);

    const bug = await listCards(ENV, DB_URL, { labelId: 'lbl-bug' });
    expect(bug.map((c) => c.id)).toEqual(['row-1']);

    const parent = await listCards(ENV, DB_URL, { parentId: 'whatever' });
    expect(parent).toEqual([]);
  });
});

describe('getCard', () => {
  it('returns a single card with body', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.retrieve.mockResolvedValue(
      fullPageRow('row-99', {
        title: 'Solo',
        statusOption: { id: 'col-doing', name: 'Doing' },
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: 'Solo body' });

    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-99');
    expect(card).toMatchObject({
      id: 'row-99',
      title: 'Solo',
      body: 'Solo body',
      columnId: 'col-doing',
    });
  });

  it('maps 404 to WorkflowApiError(404)', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.retrieve.mockRejectedValue({ code: 'object_not_found', status: 404 });
    const { getCard } = await import('../../src/notion/index.js');
    await expect(getCard(ENV, DB_URL, 'row-missing')).rejects.toMatchObject({
      name: 'WorkflowApiError',
      status: 404,
    });
  });
});

describe('readableId — Notion ID property', () => {
  beforeEach(() => {
    delete process.env['NOTION_READABLE_ID_PROPERTY'];
  });

  /** Build a fullPageRow with an extra `ID` property of the given
   * type. Notion's `unique_id` carries `{ prefix, number }`. */
  function rowWithReadableId(propName: string, value: unknown) {
    const base = fullPageRow('row-r', {
      title: 'Has Readable ID',
      statusOption: { id: 'col-todo', name: 'Todo' },
    });
    (base.properties as Record<string, unknown>)[propName] = value;
    return base;
  }

  it('renders unique_id as `<prefix>-<number>` when prefix is set', async () => {
    const schema = schemaResponse();
    (schema.properties as Record<string, unknown>).ID = {
      id: 'p_id',
      name: 'ID',
      type: 'unique_id',
      unique_id: { prefix: 'STDIO' },
    };
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schema);
    clientStub.pages.retrieve.mockResolvedValue(
      rowWithReadableId('ID', {
        id: 'p_id',
        type: 'unique_id',
        unique_id: { prefix: 'STDIO', number: 42 },
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });
    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-r');
    expect(card.readableId).toBe('STDIO-42');
  });

  it('renders unique_id as just the number when there is no prefix', async () => {
    const schema = schemaResponse();
    (schema.properties as Record<string, unknown>).ID = {
      id: 'p_id',
      name: 'ID',
      type: 'unique_id',
      unique_id: { prefix: null },
    };
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schema);
    clientStub.pages.retrieve.mockResolvedValue(
      rowWithReadableId('ID', {
        id: 'p_id',
        type: 'unique_id',
        unique_id: { prefix: null, number: 7 },
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });
    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-r');
    expect(card.readableId).toBe('7');
  });

  it('falls back to rich_text content when the property is rich_text', async () => {
    const schema = schemaResponse();
    (schema.properties as Record<string, unknown>).ID = {
      id: 'p_id',
      name: 'ID',
      type: 'rich_text',
    };
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schema);
    clientStub.pages.retrieve.mockResolvedValue(
      rowWithReadableId('ID', {
        id: 'p_id',
        type: 'rich_text',
        rich_text: [{ plain_text: 'AGY-15' }],
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });
    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-r');
    expect(card.readableId).toBe('AGY-15');
  });

  it('honours NOTION_READABLE_ID_PROPERTY env override', async () => {
    process.env['NOTION_READABLE_ID_PROPERTY'] = 'Reference';
    const schema = schemaResponse();
    (schema.properties as Record<string, unknown>).Reference = {
      id: 'p_ref',
      name: 'Reference',
      type: 'unique_id',
      unique_id: { prefix: 'REF' },
    };
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schema);
    clientStub.pages.retrieve.mockResolvedValue(
      rowWithReadableId('Reference', {
        id: 'p_ref',
        type: 'unique_id',
        unique_id: { prefix: 'REF', number: 99 },
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });
    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-r');
    expect(card.readableId).toBe('REF-99');
  });

  it('leaves readableId undefined when the configured property is absent', async () => {
    // schemaResponse() has no ID property → readableIdProp resolves to undefined
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.retrieve.mockResolvedValue(
      fullPageRow('row-99', {
        title: 'No readable ID',
        statusOption: { id: 'col-todo', name: 'Todo' },
      })
    );
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: '' });
    const { getCard } = await import('../../src/notion/index.js');
    const card = await getCard(ENV, DB_URL, 'row-99');
    expect(card).not.toHaveProperty('readableId');
  });
});

describe('isCardFresh', () => {
  it('returns true on matching last_edited_time', async () => {
    clientStub.pages.retrieve.mockResolvedValue(
      fullPageRow('row-1', { title: 'X', lastEditedTime: '2026-05-24T12:00:00.000Z' })
    );
    const { isCardFresh } = await import('../../src/notion/index.js');
    await expect(isCardFresh(ENV, DB_URL, 'row-1', '2026-05-24T12:00:00.000Z')).resolves.toBe(true);
  });

  it('returns false on drift', async () => {
    clientStub.pages.retrieve.mockResolvedValue(
      fullPageRow('row-1', { title: 'X', lastEditedTime: '2026-05-24T13:00:00.000Z' })
    );
    const { isCardFresh } = await import('../../src/notion/index.js');
    await expect(isCardFresh(ENV, DB_URL, 'row-1', '2026-05-24T12:00:00.000Z')).resolves.toBe(
      false
    );
  });

  it('returns false on 404', async () => {
    clientStub.pages.retrieve.mockRejectedValue({ code: 'object_not_found', status: 404 });
    const { isCardFresh } = await import('../../src/notion/index.js');
    await expect(isCardFresh(ENV, DB_URL, 'gone', 'v')).resolves.toBe(false);
  });
});

describe('createCard', () => {
  it('creates a row in the data source + posts body via updateMarkdown', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.create.mockResolvedValue(
      fullPageRow('row-new', {
        title: 'New card',
        statusOption: { id: 'col-todo', name: 'Todo' },
      })
    );
    clientStub.pages.updateMarkdown.mockResolvedValue({});
    clientStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: 'created body' });

    const { createCard } = await import('../../src/notion/index.js');
    const created = await createCard(ENV, DB_URL, 'col-todo', {
      title: 'New card',
      body: 'created body',
    });

    expect(created.id).toBe('row-new');
    expect(clientStub.pages.create).toHaveBeenCalledTimes(1);
    const createArgs = clientStub.pages.create.mock.calls[0]?.[0] as {
      parent: { data_source_id: string };
      properties: Record<string, unknown>;
    };
    expect(createArgs.parent.data_source_id).toBe(DS_ID);
    expect(createArgs.properties['Title']).toBeDefined();
    expect(createArgs.properties['Status']).toEqual({ status: { id: 'col-todo' } });
    expect(clientStub.pages.updateMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: 'row-new',
        type: 'replace_content',
        replace_content: { new_str: 'created body', allow_deleting_content: true },
      })
    );
  });

  it('throws 501 when setting a column on a board with no status/select property', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue({
      ...schemaResponse(),
      properties: { Title: { id: 'p_title', name: 'Title', type: 'title', title: {} } },
    });
    const { createCard } = await import('../../src/notion/index.js');
    await expect(
      createCard(ENV, DB_URL, 'col-nonexistent', { title: 'Anything' })
    ).rejects.toMatchObject({ name: 'WorkflowApiError', status: 501 });
  });
});

describe('updateCard / moveCard', () => {
  it('moveCard packages columnId into a status property update', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.update.mockResolvedValue({});
    const { moveCard } = await import('../../src/notion/index.js');
    await moveCard(ENV, DB_URL, 'row-1', 'col-done');
    const updateArgs = clientStub.pages.update.mock.calls[0]?.[0] as {
      page_id: string;
      properties: Record<string, unknown>;
    };
    expect(updateArgs.page_id).toBe('row-1');
    expect(updateArgs.properties['Status']).toEqual({ status: { id: 'col-done' } });
  });

  it('updateCard with body posts the body via updateMarkdown', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaResponse());
    clientStub.pages.update.mockResolvedValue({});
    clientStub.pages.updateMarkdown.mockResolvedValue({});
    const { updateCard } = await import('../../src/notion/index.js');
    await updateCard(ENV, DB_URL, 'row-1', { title: 'New title', body: 'New body' });
    expect(clientStub.pages.updateMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: 'row-1',
        type: 'replace_content',
        replace_content: { new_str: 'New body', allow_deleting_content: true },
      })
    );
  });
});

describe('special-character status option ids (STDIO-84 regression)', () => {
  // Notion status/select option ids are short opaque tokens, NOT UUIDs — they
  // legitimately contain characters like `?`, `>`, `|`, `<`. The adapter must
  // pass them through verbatim: sanitising or re-encoding would break column
  // reads and moveCard. The live "In preview" column's real id is `?mm>`,
  // which originally read as "garbled" but round-trips fine.
  function schemaWithOddOptionIds() {
    const schema = schemaResponse();
    (schema.properties as Record<string, unknown>).Status = {
      id: 'p_status',
      name: 'Status',
      type: 'status',
      status: {
        options: [
          { id: 'col-todo', name: 'Todo', color: 'gray' },
          { id: '?mm>', name: 'In preview', color: 'purple' },
          { id: '|nc<', name: 'Blocked', color: 'red' },
        ],
      },
    };
    return schema;
  }

  it('listColumns returns special-character option ids verbatim', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaWithOddOptionIds());
    const { listColumns } = await import('../../src/notion/index.js');
    const cols = await listColumns(ENV, DB_URL);
    expect(cols).toEqual([
      { id: 'col-todo', name: 'Todo', position: 0 },
      { id: '?mm>', name: 'In preview', position: 1 },
      { id: '|nc<', name: 'Blocked', position: 2 },
    ]);
  });

  it('moveCard sends a special-character columnId to Notion unmodified', async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue(schemaWithOddOptionIds());
    clientStub.pages.update.mockResolvedValue({});
    const { moveCard } = await import('../../src/notion/index.js');
    await moveCard(ENV, DB_URL, 'row-1', '?mm>');
    const updateArgs = clientStub.pages.update.mock.calls[0]?.[0] as {
      properties: Record<string, unknown>;
    };
    expect(updateArgs.properties['Status']).toEqual({ status: { id: '?mm>' } });
  });
});

describe('comments', () => {
  it('listComments maps Notion comments to the Comment shape', async () => {
    clientStub.comments.list.mockResolvedValue({
      results: [
        {
          id: 'c-1',
          created_time: '2026-05-24T11:00:00.000Z',
          created_by: { id: 'u-1' },
          rich_text: [{ plain_text: 'hello' }],
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    const { listComments } = await import('../../src/notion/index.js');
    const comments = await listComments(ENV, DB_URL, 'row-1');
    expect(comments).toEqual([
      { id: 'c-1', body: 'hello', authorName: 'u-1', date: '2026-05-24T11:00:00.000Z' },
    ]);
  });

  it('addComment posts to comments.create with the page parent', async () => {
    clientStub.comments.create.mockResolvedValue({});
    const { addComment } = await import('../../src/notion/index.js');
    await addComment(ENV, DB_URL, 'row-1', 'a comment');
    expect(clientStub.comments.create).toHaveBeenCalledWith({
      parent: { page_id: 'row-1' },
      rich_text: [{ type: 'text', text: { content: 'a comment' } }],
    });
  });
});

describe('listCustomFields', () => {
  it("returns properties that aren't claimed by the standard auto-detect", async () => {
    clientStub.databases.retrieve.mockResolvedValue(dbWithDataSource());
    clientStub.dataSources.retrieve.mockResolvedValue({
      ...schemaResponse(),
      properties: {
        ...schemaResponse().properties,
        Priority: {
          id: 'p_pri',
          name: 'Priority',
          type: 'select',
          select: {
            options: [
              { id: 'pri-1', name: 'High' },
              { id: 'pri-2', name: 'Low' },
            ],
          },
        },
      },
    });
    const { listCustomFields } = await import('../../src/notion/index.js');
    const fields = await listCustomFields(ENV, DB_URL);
    // Title/Status/Assignee/Tags are claimed. Priority should remain
    // (the second select-typed property — the first was already
    // claimed as Status when Status wasn't a 'status' type, but here
    // Status is a true 'status' so the first 'select' is Priority).
    expect(fields.find((f) => f.name === 'Priority')).toMatchObject({
      name: 'Priority',
      type: 'select',
      options: [
        { id: 'pri-1', name: 'High' },
        { id: 'pri-2', name: 'Low' },
      ],
    });
  });
});

describe('error mapping at the SDK boundary', () => {
  it('wraps unexpected non-404 errors as WorkflowApiError with the upstream status', async () => {
    clientStub.databases.retrieve.mockRejectedValue({ status: 500, message: 'boom' });
    const { listColumns } = await import('../../src/notion/index.js');
    await expect(listColumns(ENV, DB_URL)).rejects.toBeInstanceOf(WorkflowApiError);
  });
});
