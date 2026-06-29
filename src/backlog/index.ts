// @verevoir/workflows/backlog — Backlog.md WorkflowAdapter
//
// Maps the WorkflowAdapter contract onto a Backlog.md project (the file-native
// task manager, https://backlog.md): a `backlog/` directory holding `config.yml`
// (whose `statuses` are the columns) and `tasks/*.md` task files (each a card —
// YAML frontmatter for id / title / status / labels / assignee / parent, and a
// markdown body for the description).
//
// File access goes through a @verevoir/sources fs SourceAdapter (ADR 019: no
// direct node:fs), so the adapter works entirely in (root, relative-path) space
// and a different-backed vault is a one-line swap. Card freshness uses the
// source's content sha.

import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, parseDocument, Document } from 'yaml';
import { fs as fsSource } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import {
  WorkflowApiError,
  type Card,
  type CardCreate,
  type CardFilter,
  type CardPatch,
  type Column,
  type Comment,
  type CustomFieldDef,
  type WorkflowAdapter,
  type WorkflowEnv,
} from '../index.js';

const SOURCE_ENV: SourceEnv = { token: '', forkOrg: '' };
const DEFAULT_STATUSES = ['To Do', 'In Progress', 'Done'];
const TASKS_DIR = 'tasks';
const CONFIG_FILE = 'config.yml';

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

/** Resolve a boardUrl to the `backlog/` directory, or null when it isn't a
 * Backlog board path. Accepts an absolute path (or `file://` URL) to the project
 * root (which contains `backlog/`) or to the `backlog/` directory itself; a path
 * to a `.md` file is rejected (that's an Obsidian board, not a Backlog project). */
export function parseBacklogBoardPath(input: string): { backlogDir: string } | null {
  let path = input.trim();
  if (path.startsWith('file://')) path = fileURLToPath(path);
  if (!path.startsWith('/')) return null;
  if (path.endsWith('.md')) return null;
  const abs = resolve(path);
  const backlogDir = basename(abs) === 'backlog' ? abs : `${abs}/backlog`;
  return { backlogDir };
}

function backlogDirOf(boardUrl: string): string {
  const parsed = parseBacklogBoardPath(boardUrl);
  if (!parsed) throw new WorkflowApiError(`Cannot parse Backlog board path: ${boardUrl}`, 404);
  return parsed.backlogDir;
}

/** No credentials needed; provided for symmetry with the other adapters. */
export function envFromBacklogProcessEnv(): WorkflowEnv {
  return { token: '' };
}

// ---------------------------------------------------------------------------
// Config + task-file I/O (all through the SourceAdapter)
// ---------------------------------------------------------------------------

/** The board's columns, in order: the `statuses` list from `config.yml`, or a
 * sensible default when the project has no config / no statuses. */
async function readStatuses(backlogDir: string): Promise<string[]> {
  const content = await maybeRead(backlogDir, CONFIG_FILE);
  if (content !== null) {
    const cfg = parseYaml(content) as { statuses?: unknown } | null;
    const statuses = cfg?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      return statuses.map((s) => String(s).trim()).filter(Boolean);
    }
  }
  return DEFAULT_STATUSES;
}

/** Read a file under the backlog dir, or null when it doesn't exist. */
async function maybeRead(backlogDir: string, rel: string): Promise<string | null> {
  try {
    return (await fsSource.readFile(SOURCE_ENV, backlogDir, rel)).content;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** The `.md` filenames under `tasks/`, or empty when the directory is absent. */
async function taskFileNames(backlogDir: string): Promise<string[]> {
  try {
    const entries = await fsSource.listFiles(SOURCE_ENV, backlogDir, TASKS_DIR);
    return entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return [];
    throw err;
  }
}

interface TaskFile {
  fileName: string;
  raw: string;
  sha: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

async function readTask(backlogDir: string, fileName: string): Promise<TaskFile> {
  const { content, sha } = await fsSource.readFile(
    SOURCE_ENV,
    backlogDir,
    `${TASKS_DIR}/${fileName}`
  );
  return { fileName, raw: content, sha, ...splitFrontmatter(content) };
}

/** The id a task is addressed by — its `id` frontmatter, falling back to the
 * filename stem so a task without an explicit id is still reachable. */
function taskId(task: TaskFile): string {
  const id = task.frontmatter['id'];
  return id != null && String(id).trim() !== ''
    ? String(id).trim()
    : basename(task.fileName, '.md');
}

async function findTask(backlogDir: string, cardId: string): Promise<TaskFile | undefined> {
  for (const name of await taskFileNames(backlogDir)) {
    const task = await readTask(backlogDir, name);
    if (taskId(task) === cardId) return task;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Frontmatter format (YAML between --- fences + markdown body)
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(FRONTMATTER);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter = (parseDocument(match[1]).toJS() ?? {}) as Record<string, unknown>;
  return { frontmatter, body: text.slice(match[0].length) };
}

function serialiseTask(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${new Document(frontmatter).toString()}---\n${body}`;
}

/** Apply frontmatter updates, preserving every other key and the body. */
function editFrontmatter(text: string, updates: Record<string, unknown>): string {
  const match = text.match(FRONTMATTER);
  const doc = match ? parseDocument(match[1]) : new Document({});
  for (const [key, value] of Object.entries(updates)) doc.set(key, value);
  const body = match ? text.slice(match[0].length) : text;
  return `---\n${doc.toString()}---\n${body}`;
}

function setBody(text: string, body: string): string {
  const match = text.match(FRONTMATTER);
  return match ? match[0] + body : body;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** A frontmatter value as a string list — tolerating a scalar, a list, or
 * absence (so `labels: bug` and `labels: [bug, ui]` both work). */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value != null && String(value).trim() !== '') return [String(value).trim()];
  return [];
}

function toCard(task: TaskFile, includeBody: boolean): Card {
  const id = taskId(task);
  const fm = task.frontmatter;
  const status = String(fm['status'] ?? '').trim();
  const parent = fm['parent_task_id'] ?? fm['parent'];
  return {
    id,
    readableId: id,
    title: String(fm['title'] ?? basename(task.fileName, '.md')),
    body: includeBody ? task.body : '',
    columnId: status,
    columnName: status,
    ...(parent != null && String(parent).trim() !== '' ? { parentId: String(parent).trim() } : {}),
    // Backlog assignees are conventionally `@handle`; expose the bare handle.
    assigneeIds: stringList(fm['assignee']).map((a) => a.replace(/^@/, '')),
    labels: stringList(fm['labels']).map((t) => ({ id: t, name: t })),
    lastActivity: task.sha,
  };
}

// ---------------------------------------------------------------------------
// Adapter methods
// ---------------------------------------------------------------------------

export async function listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
  void env;
  const statuses = await readStatuses(backlogDirOf(boardUrl));
  return statuses.map((name, position) => ({ id: name, name, position }));
}

export async function listCards(
  env: WorkflowEnv,
  boardUrl: string,
  filter?: CardFilter
): Promise<Card[]> {
  void env;
  const dir = backlogDirOf(boardUrl);
  const includeBody = filter?.includeBody ?? true;
  let cards: Card[] = [];
  for (const name of await taskFileNames(dir)) {
    cards.push(toCard(await readTask(dir, name), includeBody));
  }
  if (filter?.columnId !== undefined) cards = cards.filter((c) => c.columnId === filter.columnId);
  if (filter?.labelId !== undefined)
    cards = cards.filter((c) => c.labels.some((l) => l.id === filter.labelId));
  if (filter?.assigneeId !== undefined)
    cards = cards.filter((c) => c.assigneeIds.includes(filter.assigneeId as string));
  if (filter?.parentId !== undefined) cards = cards.filter((c) => c.parentId === filter.parentId);
  if (filter?.limit !== undefined) cards = cards.slice(0, filter.limit);
  return cards;
}

export async function getCard(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Card> {
  void env;
  const task = await findTask(backlogDirOf(boardUrl), cardId);
  if (!task) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);
  return toCard(task, true);
}

export async function isCardFresh(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  void env;
  const task = await findTask(backlogDirOf(boardUrl), cardId);
  return task ? task.sha === version : false;
}

export async function createCard(
  env: WorkflowEnv,
  boardUrl: string,
  columnId: string,
  fields: CardCreate
): Promise<Card> {
  void env;
  const dir = backlogDirOf(boardUrl);
  const statuses = await readStatuses(dir);
  if (!statuses.includes(columnId))
    throw new WorkflowApiError(`Column not found: ${columnId}`, 404);

  const id = await nextTaskId(dir);
  const frontmatter: Record<string, unknown> = { id, title: fields.title, status: columnId };
  if (fields.labelIds?.length) frontmatter['labels'] = fields.labelIds;
  if (fields.assigneeIds?.length) frontmatter['assignee'] = fields.assigneeIds;
  if (fields.parentId) frontmatter['parent_task_id'] = fields.parentId;

  const fileName = `${id} - ${slug(fields.title)}.md`;
  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${fileName}`,
    serialiseTask(frontmatter, fields.body ?? ''),
    'local',
    `create ${id}`
  );
  return getCard(env, boardUrl, id);
}

export async function updateCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  patch: CardPatch
): Promise<void> {
  void env;
  const dir = backlogDirOf(boardUrl);
  const task = await findTask(dir, cardId);
  if (!task) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);

  const updates: Record<string, unknown> = {};
  if (patch.title !== undefined) updates['title'] = patch.title;
  if (patch.columnId !== undefined) updates['status'] = patch.columnId;
  if (patch.labelIds !== undefined) updates['labels'] = patch.labelIds;
  if (patch.assigneeIds !== undefined) updates['assignee'] = patch.assigneeIds;
  if (patch.parentId !== undefined) updates['parent_task_id'] = patch.parentId;

  let text = task.raw;
  if (Object.keys(updates).length > 0) text = editFrontmatter(text, updates);
  if (patch.body !== undefined) text = setBody(text, patch.body);
  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${task.fileName}`,
    text,
    'local',
    `update ${cardId}`
  );
}

export async function moveCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  toColumnId: string
): Promise<void> {
  const dir = backlogDirOf(boardUrl);
  const statuses = await readStatuses(dir);
  if (!statuses.includes(toColumnId))
    throw new WorkflowApiError(`Column not found: ${toColumnId}`, 404);
  await updateCard(env, boardUrl, cardId, { columnId: toColumnId });
}

export async function listComments(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string
): Promise<Comment[]> {
  void env;
  void boardUrl;
  void cardId;
  return [];
}

export async function addComment(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  body: string
): Promise<void> {
  void env;
  void boardUrl;
  void cardId;
  void body;
  throw new WorkflowApiError('Backlog.md tasks have no separate comment concept', 501);
}

export async function listCustomFields(
  env: WorkflowEnv,
  boardUrl: string
): Promise<CustomFieldDef[]> {
  void env;
  void boardUrl;
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The next free `task-N` id — one past the highest numbered task on the board. */
async function nextTaskId(backlogDir: string): Promise<string> {
  let highest = 0;
  for (const name of await taskFileNames(backlogDir)) {
    const match = taskId(await readTask(backlogDir, name)).match(/task-(\d+)/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `task-${highest + 1}`;
}

/** A filesystem-safe title fragment for a task filename. */
function slug(title: string): string {
  return (title || 'untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'untitled';
}

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const backlog: WorkflowAdapter = {
  listColumns,
  listCards,
  getCard,
  isCardFresh,
  createCard,
  updateCard,
  moveCard,
  listComments,
  addComment,
  listCustomFields,
};
