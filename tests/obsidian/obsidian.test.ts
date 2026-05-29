import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { obsidian, parseObsidianBoardPath } from '../../src/obsidian/index.js';
import { WorkflowApiError } from '../../src/index.js';

const env = { token: '' };

let vault: string;
let boardDir: string;
let boardPath: string;

function note(name: string, frontmatter: string, body: string): void {
  writeFileSync(join(boardDir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'obs-adapter-'));
  boardDir = join(vault, 'Board');
  mkdirSync(boardDir);
  process.env['OBSIDIAN_VAULT_PATH'] = vault;
  delete process.env['OBSIDIAN_CARD_FOLDER'];

  note(
    'Test Card',
    'id: "card-1"\ntitle: Wire the adapter\ntags:\n  - infra',
    '# Wire the adapter\n'
  );
  note('No Id Card', 'tags:\n  - orphan', '# No Id\n');

  boardPath = join(boardDir, 'Board.md');
  writeFileSync(
    boardPath,
    `---

kanban-plugin: board

---

## To Do

- [ ] [[Test Card]]
- [ ] [[No Id Card]]
- [ ] a plain card

## In Progress


%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%`
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  delete process.env['OBSIDIAN_VAULT_PATH'];
});

describe('parseObsidianBoardPath', () => {
  it('accepts an absolute path', () => {
    expect(parseObsidianBoardPath('/abs/Board.md')).toEqual({ filePath: '/abs/Board.md' });
  });

  it('accepts a file:// URL', () => {
    expect(parseObsidianBoardPath(pathToFileURL('/abs/Board.md').href)).toEqual({
      filePath: '/abs/Board.md',
    });
  });

  it('rejects a relative path', () => {
    expect(parseObsidianBoardPath('Board.md')).toBeNull();
  });
});

describe('listColumns', () => {
  it('returns lanes as ordered columns', async () => {
    const cols = await obsidian.listColumns(env, boardPath);
    expect(cols).toEqual([
      { id: 'To Do', name: 'To Do', position: 0 },
      { id: 'In Progress', name: 'In Progress', position: 1 },
    ]);
  });
});

describe('listCards', () => {
  it('returns id-bearing linked cards and skips plain / id-less cards', async () => {
    const cards = await obsidian.listCards(env, boardPath);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.id).toBe('card-1');
    expect(card.readableId).toBe('card-1');
    expect(card.title).toBe('Wire the adapter');
    expect(card.columnId).toBe('To Do');
    expect(card.labels).toEqual([{ id: 'infra', name: 'infra' }]);
    expect(card.url).toBe(pathToFileURL(join(boardDir, 'Test Card.md')).href);
  });

  it('falls back to the filename for title when no title frontmatter', async () => {
    note('Bare', 'id: "bare-1"', '# Bare\n');
    writeFileSync(
      boardPath,
      readFileSync(boardPath, 'utf8').replace('## In Progress', '- [ ] [[Bare]]\n\n## In Progress')
    );
    const cards = await obsidian.listCards(env, boardPath);
    const bare = cards.find((c) => c.id === 'bare-1');
    expect(bare?.title).toBe('Bare');
  });

  it('omits body when includeBody is false', async () => {
    const cards = await obsidian.listCards(env, boardPath, { includeBody: false });
    expect(cards[0].body).toBe('');
  });

  it('filters by column', async () => {
    expect(await obsidian.listCards(env, boardPath, { columnId: 'In Progress' })).toEqual([]);
  });
});

describe('getCard', () => {
  it('returns a single card with body', async () => {
    const card = await obsidian.getCard(env, boardPath, 'card-1');
    expect(card.title).toBe('Wire the adapter');
    expect(card.body).toBe('# Wire the adapter\n');
  });

  it('throws 404 for an unknown id', async () => {
    await expect(obsidian.getCard(env, boardPath, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createCard', () => {
  it('writes a new note and links it from the target lane', async () => {
    const card = await obsidian.createCard(env, boardPath, 'In Progress', {
      title: 'Brand New',
      body: 'Do the thing\n',
      labelIds: ['feature'],
    });
    expect(card.id).toBeTruthy();
    expect(card.columnId).toBe('In Progress');
    expect(existsSync(join(boardDir, 'Brand New.md'))).toBe(true);
    const board = readFileSync(boardPath, 'utf8');
    expect(board).toContain('[[Brand New]]');
    // round-trips back through getCard
    const fetched = await obsidian.getCard(env, boardPath, card.id);
    expect(fetched.title).toBe('Brand New');
    expect(fetched.labels).toEqual([{ id: 'feature', name: 'feature' }]);
  });
});

describe('updateCard', () => {
  it('writes title to frontmatter without renaming the file', async () => {
    await obsidian.updateCard(env, boardPath, 'card-1', { title: 'Renamed' });
    expect(existsSync(join(boardDir, 'Test Card.md'))).toBe(true);
    expect((await obsidian.getCard(env, boardPath, 'card-1')).title).toBe('Renamed');
  });

  it('moves the card when columnId changes', async () => {
    await obsidian.updateCard(env, boardPath, 'card-1', { columnId: 'In Progress' });
    expect((await obsidian.getCard(env, boardPath, 'card-1')).columnId).toBe('In Progress');
  });

  it('rejects parentId with 501', async () => {
    await expect(
      obsidian.updateCard(env, boardPath, 'card-1', { parentId: 'x' })
    ).rejects.toMatchObject({ status: 501 });
  });

  it('rejects assignee writes with 501', async () => {
    await expect(
      obsidian.updateCard(env, boardPath, 'card-1', { assigneeIds: ['a'] })
    ).rejects.toMatchObject({ status: 501 });
  });
});

describe('moveCard', () => {
  it('relocates the card to another lane', async () => {
    await obsidian.moveCard(env, boardPath, 'card-1', 'In Progress');
    const cards = await obsidian.listCards(env, boardPath, { columnId: 'In Progress' });
    expect(cards.map((c) => c.id)).toEqual(['card-1']);
  });
});

describe('comments + custom fields', () => {
  it('listComments is empty and addComment is unsupported', async () => {
    expect(await obsidian.listComments(env, boardPath, 'card-1')).toEqual([]);
    await expect(obsidian.addComment(env, boardPath, 'card-1', 'hi')).rejects.toMatchObject({
      status: 501,
    });
  });

  it('listCustomFields is empty', async () => {
    expect(await obsidian.listCustomFields(env, boardPath)).toEqual([]);
  });
});

describe('isCardFresh', () => {
  it('is true for the current version and false after an edit', async () => {
    const card = await obsidian.getCard(env, boardPath, 'card-1');
    expect(await obsidian.isCardFresh(env, boardPath, 'card-1', card.lastActivity!)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    await obsidian.updateCard(env, boardPath, 'card-1', { title: 'Touched' });
    expect(await obsidian.isCardFresh(env, boardPath, 'card-1', card.lastActivity!)).toBe(false);
  });
});
