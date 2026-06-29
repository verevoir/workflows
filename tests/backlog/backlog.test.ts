import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backlog, parseBacklogBoardPath } from '../../src/backlog/index.js';

const env = { token: '' };

let projectRoot: string;
let tasksDir: string;

/** Write a task file `task-<n> - <slug>.md` with the given frontmatter + body. */
function writeTask(id: string, frontmatter: string, body = ''): void {
  writeFileSync(join(tasksDir, `${id} - sample.md`), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'backlog-'));
  const backlogDir = join(projectRoot, 'backlog');
  tasksDir = join(backlogDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(backlogDir, 'config.yml'),
    'project_name: Test\nstatuses:\n  - To Do\n  - In Progress\n  - Done\n'
  );
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('parseBacklogBoardPath', () => {
  it('resolves a project root to its backlog/ directory', () => {
    expect(parseBacklogBoardPath('/work/proj')).toEqual({ backlogDir: '/work/proj/backlog' });
  });

  it('uses a path that already points at backlog/ as-is', () => {
    expect(parseBacklogBoardPath('/work/proj/backlog')).toEqual({
      backlogDir: '/work/proj/backlog',
    });
  });

  it('accepts a file:// URL', () => {
    expect(parseBacklogBoardPath('file:///work/proj')).toEqual({
      backlogDir: '/work/proj/backlog',
    });
  });

  it('rejects a .md path (that is an Obsidian board, not a Backlog project)', () => {
    expect(parseBacklogBoardPath('/work/proj/Board.md')).toBeNull();
  });

  it('rejects a relative path', () => {
    expect(parseBacklogBoardPath('proj/backlog')).toBeNull();
  });
});

describe('listColumns', () => {
  it('returns the statuses from config.yml, in order', async () => {
    const columns = await backlog.listColumns(env, projectRoot);
    expect(columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(columns[0].position).toBe(0);
  });

  it('falls back to default statuses when there is no config', async () => {
    rmSync(join(projectRoot, 'backlog', 'config.yml'));
    const columns = await backlog.listColumns(env, projectRoot);
    expect(columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
  });
});

describe('listCards', () => {
  beforeEach(() => {
    writeTask(
      'task-1',
      'id: task-1\ntitle: First\nstatus: To Do\nlabels:\n  - bug',
      'do the thing'
    );
    writeTask(
      'task-2',
      'id: task-2\ntitle: Second\nstatus: In Progress\nassignee:\n  - "@alice"\nparent_task_id: task-1'
    );
  });

  it('maps each task file to a card with status as the column', async () => {
    const cards = await backlog.listCards(env, projectRoot);
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(byId['task-1'].title).toBe('First');
    expect(byId['task-1'].columnId).toBe('To Do');
    expect(byId['task-1'].labels.map((l) => l.name)).toEqual(['bug']);
    expect(byId['task-1'].body).toContain('do the thing');
    expect(byId['task-2'].assigneeIds).toEqual(['alice']);
    expect(byId['task-2'].parentId).toBe('task-1');
  });

  it('filters by column', async () => {
    const cards = await backlog.listCards(env, projectRoot, { columnId: 'In Progress' });
    expect(cards.map((c) => c.id)).toEqual(['task-2']);
  });

  it('filters by label', async () => {
    const cards = await backlog.listCards(env, projectRoot, { labelId: 'bug' });
    expect(cards.map((c) => c.id)).toEqual(['task-1']);
  });

  it('filters by parent', async () => {
    const cards = await backlog.listCards(env, projectRoot, { parentId: 'task-1' });
    expect(cards.map((c) => c.id)).toEqual(['task-2']);
  });

  it('omits the body when includeBody is false', async () => {
    const cards = await backlog.listCards(env, projectRoot, { includeBody: false });
    expect(cards.every((c) => c.body === '')).toBe(true);
  });
});

describe('getCard', () => {
  it('returns a single card by id', async () => {
    writeTask('task-7', 'id: task-7\ntitle: Lucky\nstatus: Done');
    const card = await backlog.getCard(env, projectRoot, 'task-7');
    expect(card.title).toBe('Lucky');
    expect(card.columnId).toBe('Done');
  });

  it('throws a 404 for a missing card', async () => {
    await expect(backlog.getCard(env, projectRoot, 'task-99')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('createCard', () => {
  it('writes a new task in the column with the next free id, and reads it back', async () => {
    writeTask('task-3', 'id: task-3\ntitle: Existing\nstatus: To Do');
    const created = await backlog.createCard(env, projectRoot, 'In Progress', {
      title: 'Brand new',
      body: 'details',
    });
    expect(created.id).toBe('task-4');
    expect(created.columnId).toBe('In Progress');
    expect(created.title).toBe('Brand new');

    // It is persisted and listed.
    const cards = await backlog.listCards(env, projectRoot);
    expect(cards.map((c) => c.id)).toContain('task-4');
  });

  it('rejects an unknown column', async () => {
    await expect(
      backlog.createCard(env, projectRoot, 'Nonexistent', { title: 'x' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('moveCard / updateCard', () => {
  beforeEach(() =>
    writeTask('task-1', 'id: task-1\ntitle: Movable\nstatus: To Do\ncreated_date: "2025-01-01"')
  );

  it('moveCard changes the task status, preserving other frontmatter', async () => {
    await backlog.moveCard(env, projectRoot, 'task-1', 'Done');
    const card = await backlog.getCard(env, projectRoot, 'task-1');
    expect(card.columnId).toBe('Done');
    // The unmanaged created_date survives the edit.
    expect(readFileSync(join(tasksDir, 'task-1 - sample.md'), 'utf8')).toContain('created_date');
  });

  it('moveCard rejects an unknown column', async () => {
    await expect(backlog.moveCard(env, projectRoot, 'task-1', 'Nope')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('updateCard changes the title and body', async () => {
    await backlog.updateCard(env, projectRoot, 'task-1', { title: 'Renamed', body: 'new body' });
    const card = await backlog.getCard(env, projectRoot, 'task-1');
    expect(card.title).toBe('Renamed');
    expect(card.body).toContain('new body');
  });
});

describe('comments', () => {
  it('lists no comments (Backlog has no comment concept)', async () => {
    expect(await backlog.listComments(env, projectRoot, 'task-1')).toEqual([]);
  });

  it('rejects addComment as unsupported', async () => {
    await expect(backlog.addComment(env, projectRoot, 'task-1', 'hi')).rejects.toMatchObject({
      status: 501,
    });
  });
});
