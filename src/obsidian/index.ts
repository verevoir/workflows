// @verevoir/workflows/obsidian — Obsidian Kanban WorkflowAdapter
//
// Maps the WorkflowAdapter contract onto an Obsidian Kanban board:
//   - boardUrl is an absolute path (or file:// URL) to the board .md.
//   - A `## heading` is a Column; its id is the lane name.
//   - A `- [ ] [[Note]]` board item is a Card whose identity and content
//     live in the linked note (the source of truth).
//   - Card identity is the linked note's `id` frontmatter field. Cards
//     that are plain text, unresolvable, or lack an id are skipped on
//     reads and 404 when addressed.
//
// File access goes through a `@verevoir/sources` SourceAdapter — the
// local `fs` adapter today (ADR 019 / ADR 017: no direct `node:fs`).
// Everything below operates in the adapter's `(root, relative-path)`
// space, so swapping in a GitHub-hosted-vault SourceAdapter is a single
// change here, not a rewrite. Freshness uses the adapter's content sha.
//
// No credentials. Behaviour is tuned via env vars (read at call time):
//   OBSIDIAN_VAULT_PATH   vault root (source root + enables wikilink fallback)
//   OBSIDIAN_ID_FIELD     identity frontmatter field (default "id")
//   OBSIDIAN_CARD_FOLDER  where createCard writes notes (default: board dir)
//   OBSIDIAN_DATE_FIELD   due-date frontmatter field (default "due")
//   OBSIDIAN_TAGS_FIELD   labels frontmatter field (default "tags")

import { dirname, basename, relative, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
  type Label,
  type WorkflowAdapter,
  type WorkflowEnv,
} from '../index.js';
import { parseBoard, serializeBoard, type Board, type BoardCard } from './board-format.js';
import { parseNote, serializeNote, editNoteFrontmatter, setNoteBody } from './note.js';
import { resolveWikilink } from './wikilink.js';

// The fs SourceAdapter ignores auth; this is the env it accepts.
const SOURCE_ENV: SourceEnv = { token: '', forkOrg: '' };

// ---------------------------------------------------------------------------
// Path parsing + config
// ---------------------------------------------------------------------------

/** Resolves a boardUrl (absolute path or file:// URL) to a file path.
 * Returns null for relative paths. */
export function parseObsidianBoardPath(input: string): { filePath: string } | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('file://')) return { filePath: fileURLToPath(trimmed) };
  if (trimmed.startsWith('/')) return { filePath: trimmed };
  return null;
}

interface Config {
  idField: string;
  dateField: string;
  tagsField: string;
  cardFolder?: string;
  vaultRoot?: string;
}

function config(): Config {
  return {
    idField: process.env['OBSIDIAN_ID_FIELD'] || 'id',
    dateField: process.env['OBSIDIAN_DATE_FIELD'] || 'due',
    tagsField: process.env['OBSIDIAN_TAGS_FIELD'] || 'tags',
    ...(process.env['OBSIDIAN_CARD_FOLDER']
      ? { cardFolder: process.env['OBSIDIAN_CARD_FOLDER'] }
      : {}),
    ...(process.env['OBSIDIAN_VAULT_PATH']
      ? { vaultRoot: process.env['OBSIDIAN_VAULT_PATH'] }
      : {}),
  };
}

/** No credentials needed; provided for symmetry with the other adapters. */
export function envFromObsidianProcessEnv(): WorkflowEnv {
  return { token: '' };
}

// ---------------------------------------------------------------------------
// Source layout (the seam — maps a boardUrl onto SourceAdapter coordinates)
// ---------------------------------------------------------------------------

interface Layout {
  /** Absolute source root passed to the SourceAdapter. */
  root: string;
  /** Board file, relative to root. */
  boardPathRel: string;
  /** Board's folder, relative to root. */
  boardDirRel: string;
  /** Folder createCard writes into, relative to root. */
  cardDirRel: string;
  /** Whether wikilink resolution may scan the whole tree. */
  vaultFallback: boolean;
}

function relToRoot(root: string, p: string): string {
  const r = relative(root, resolve(p));
  return r === '.' ? '' : r;
}

function layout(boardUrl: string, cfg: Config): Layout {
  const parsed = parseObsidianBoardPath(boardUrl);
  if (!parsed) throw new WorkflowApiError(`Cannot parse Obsidian board path: ${boardUrl}`);
  const boardAbs = resolve(parsed.filePath);
  const root = cfg.vaultRoot ? resolve(cfg.vaultRoot) : dirname(boardAbs);
  const boardPathRel = relToRoot(root, boardAbs);
  if (boardPathRel.startsWith('..')) {
    throw new WorkflowApiError(`Board file is outside the configured vault root: ${boardUrl}`, 404);
  }
  const boardDirRel = relToRoot(root, dirname(boardAbs));
  const cardDirRel = cfg.cardFolder ? relToRoot(root, cfg.cardFolder) : boardDirRel;
  return {
    root,
    boardPathRel,
    boardDirRel,
    cardDirRel,
    vaultFallback: cfg.vaultRoot !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Board + note I/O (all through the SourceAdapter)
// ---------------------------------------------------------------------------

async function readBoard(lay: Layout): Promise<{ text: string; sha: string }> {
  try {
    const { content, sha } = await fsSource.readFile(SOURCE_ENV, lay.root, lay.boardPathRel);
    return { text: content, sha };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      throw new WorkflowApiError(`Board file not found: ${lay.boardPathRel}`, 404);
    }
    throw err;
  }
}

async function writeBoard(lay: Layout, board: Board, message: string): Promise<void> {
  await fsSource.writeFile(
    SOURCE_ENV,
    lay.root,
    lay.boardPathRel,
    serializeBoard(board),
    'local',
    message
  );
}

// ---------------------------------------------------------------------------
// Card resolution + mapping
// ---------------------------------------------------------------------------

interface ResolvedCard {
  laneName: string;
  boardCard: BoardCard;
  /** Note path relative to root. */
  noteRel: string;
  /** Note content sha (from the SourceAdapter). */
  noteSha: string;
  /** Raw note text — kept so edits preserve unmanaged content. */
  noteText: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Resolves a single board card to its linked note, or null when the
 * card is plain text, unresolvable, or its note lacks an id. */
async function resolveCard(
  laneName: string,
  boardCard: BoardCard,
  lay: Layout,
  cfg: Config
): Promise<ResolvedCard | null> {
  if (!boardCard.link) return null;
  const noteRel = await resolveWikilink(fsSource, SOURCE_ENV, lay.root, boardCard.link.target, {
    boardDirRel: lay.boardDirRel,
    ...(lay.cardDirRel ? { cardDirRel: lay.cardDirRel } : {}),
    vaultFallback: lay.vaultFallback,
  });
  if (!noteRel) return null;
  let read;
  try {
    read = await fsSource.readFile(SOURCE_ENV, lay.root, noteRel);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  const { frontmatter, body } = parseNote(read.content);
  const id = frontmatter[cfg.idField];
  if (id == null || String(id).trim() === '') return null;
  return {
    laneName,
    boardCard,
    noteRel,
    noteSha: read.sha,
    noteText: read.content,
    frontmatter,
    body,
  };
}

/** Resolves every id-bearing linked card on the board. */
async function resolveCards(board: Board, lay: Layout, cfg: Config): Promise<ResolvedCard[]> {
  const out: ResolvedCard[] = [];
  for (const lane of board.lanes) {
    for (const boardCard of lane.cards) {
      const rc = await resolveCard(lane.name, boardCard, lay, cfg);
      if (rc) out.push(rc);
    }
  }
  return out;
}

/** Finds the resolved card with the given id, short-circuiting on the
 * first match rather than resolving the whole board first. */
async function findById(
  board: Board,
  lay: Layout,
  cfg: Config,
  cardId: string
): Promise<ResolvedCard | undefined> {
  for (const lane of board.lanes) {
    for (const boardCard of lane.cards) {
      const rc = await resolveCard(lane.name, boardCard, lay, cfg);
      if (rc && String(rc.frontmatter[cfg.idField]) === cardId) return rc;
    }
  }
  return undefined;
}

function readLabels(frontmatter: Record<string, unknown>, cfg: Config): Label[] {
  const raw = frontmatter[cfg.tagsField];
  const tags = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return tags.map((t) => ({ id: String(t), name: String(t) }));
}

function toCard(
  rc: ResolvedCard,
  lay: Layout,
  boardSha: string,
  cfg: Config,
  includeBody: boolean
): Card {
  const id = String(rc.frontmatter[cfg.idField]);
  const titleField = rc.frontmatter['title'];
  const title =
    titleField != null && String(titleField).trim() !== ''
      ? String(titleField)
      : basename(rc.noteRel, '.md');
  const due = rc.frontmatter[cfg.dateField];
  return {
    id,
    readableId: id,
    title,
    body: includeBody ? rc.body : '',
    columnId: rc.laneName,
    columnName: rc.laneName,
    assigneeIds: [],
    labels: readLabels(rc.frontmatter, cfg),
    ...(due != null && String(due).trim() !== '' ? { dueDate: String(due) } : {}),
    url: pathToFileURL(join(lay.root, rc.noteRel)).href,
    // Composite content sha — opaque change handle covering note edits
    // (first component) and board moves/reordering (second). Both shift
    // on the relevant change; neither can mask the other.
    lastActivity: `${rc.noteSha}|${boardSha}`,
  };
}

// ---------------------------------------------------------------------------
// Adapter methods
// ---------------------------------------------------------------------------

export async function listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
  void env;
  const lay = layout(boardUrl, config());
  const { text } = await readBoard(lay);
  const board = parseBoard(text);
  return board.lanes.map((lane, idx) => ({ id: lane.name, name: lane.name, position: idx }));
}

export async function listCards(
  env: WorkflowEnv,
  boardUrl: string,
  filter?: CardFilter
): Promise<Card[]> {
  void env;
  if (filter?.parentId !== undefined) return [];
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text, sha } = await readBoard(lay);
  const board = parseBoard(text);
  const includeBody = filter?.includeBody ?? true;
  let cards = (await resolveCards(board, lay, cfg)).map((rc) =>
    toCard(rc, lay, sha, cfg, includeBody)
  );
  if (filter?.columnId !== undefined) cards = cards.filter((c) => c.columnId === filter.columnId);
  if (filter?.labelId !== undefined)
    cards = cards.filter((c) => c.labels.some((l) => l.id === filter.labelId));
  if (filter?.assigneeId !== undefined) cards = [];
  if (filter?.limit !== undefined) cards = cards.slice(0, filter.limit);
  return cards;
}

export async function getCard(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Card> {
  void env;
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text, sha } = await readBoard(lay);
  const rc = await findById(parseBoard(text), lay, cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);
  return toCard(rc, lay, sha, cfg, true);
}

export async function isCardFresh(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  void env;
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text, sha } = await readBoard(lay);
  const rc = await findById(parseBoard(text), lay, cfg, cardId);
  if (!rc) return false;
  return version === `${rc.noteSha}|${sha}`;
}

export async function createCard(
  env: WorkflowEnv,
  boardUrl: string,
  columnId: string,
  fields: CardCreate
): Promise<Card> {
  void env;
  if (fields.parentId !== undefined) {
    throw new WorkflowApiError('Obsidian cards are flat; parentId is not supported', 501);
  }
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text } = await readBoard(lay);
  const board = parseBoard(text);
  const lane = board.lanes.find((l) => l.name === columnId);
  if (!lane) throw new WorkflowApiError(`Column not found: ${columnId}`, 404);

  const noteName = await uniqueNoteName(lay, fields.title);
  const frontmatter: Record<string, unknown> = { [cfg.idField]: randomUUID() };
  if (fields.title) frontmatter['title'] = fields.title;
  if (fields.labelIds) frontmatter[cfg.tagsField] = fields.labelIds;
  if (fields.dueDate) frontmatter[cfg.dateField] = fields.dueDate;
  const noteRel = lay.cardDirRel ? `${lay.cardDirRel}/${noteName}.md` : `${noteName}.md`;
  await fsSource.writeFile(
    SOURCE_ENV,
    lay.root,
    noteRel,
    serializeNote(frontmatter, fields.body ?? ''),
    'local',
    'create card note'
  );

  lane.cards.push({ rawLine: `- [ ] [[${noteName}]]`, checked: false, link: { target: noteName } });
  await writeBoard(lay, board, 'add card to board');

  const created = await getCardByNoteName(lay, noteName, cfg);
  if (!created) throw new WorkflowApiError('Created card could not be read back', 500);
  return created;
}

export async function updateCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  patch: CardPatch
): Promise<void> {
  void env;
  if (patch.parentId !== undefined) {
    throw new WorkflowApiError('Obsidian cards are flat; parentId is not supported', 501);
  }
  if (patch.assigneeIds !== undefined) {
    throw new WorkflowApiError('Obsidian has no assignee concept', 501);
  }
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text } = await readBoard(lay);
  const board = parseBoard(text);
  const rc = await findById(board, lay, cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);

  const fmUpdates: Record<string, unknown> = {};
  if (patch.title !== undefined) fmUpdates['title'] = patch.title;
  if (patch.labelIds !== undefined) fmUpdates[cfg.tagsField] = patch.labelIds;
  if (patch.dueDate !== undefined) fmUpdates[cfg.dateField] = patch.dueDate;

  let noteText = rc.noteText;
  if (Object.keys(fmUpdates).length > 0) noteText = editNoteFrontmatter(noteText, fmUpdates);
  if (patch.body !== undefined) noteText = setNoteBody(noteText, patch.body);
  await fsSource.writeFile(SOURCE_ENV, lay.root, rc.noteRel, noteText, 'local', 'update card note');

  if (patch.columnId !== undefined && patch.columnId !== rc.laneName) {
    moveBoardCard(board, rc.boardCard, patch.columnId);
    await writeBoard(lay, board, 'move card');
  }
}

export async function moveCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  toColumnId: string
): Promise<void> {
  void env;
  const cfg = config();
  const lay = layout(boardUrl, cfg);
  const { text } = await readBoard(lay);
  const board = parseBoard(text);
  const rc = await findById(board, lay, cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);
  moveBoardCard(board, rc.boardCard, toColumnId);
  await writeBoard(lay, board, 'move card');
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
  throw new WorkflowApiError('Obsidian Kanban has no comment concept', 501);
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

function moveBoardCard(board: Board, card: BoardCard, toColumnId: string): void {
  const target = board.lanes.find((l) => l.name === toColumnId);
  if (!target) throw new WorkflowApiError(`Column not found: ${toColumnId}`, 404);
  for (const lane of board.lanes) {
    const idx = lane.cards.indexOf(card);
    if (idx !== -1) {
      lane.cards.splice(idx, 1);
      break;
    }
  }
  target.cards.push(card);
}

/** Picks a note filename not already present in the card folder. */
async function uniqueNoteName(lay: Layout, title: string): Promise<string> {
  const safe = (title || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Untitled';
  const taken = await existingNoteNames(lay);
  if (!taken.has(`${safe}.md`)) return safe;
  for (let n = 1; ; n++) {
    const candidate = `${safe} ${n}`;
    if (!taken.has(`${candidate}.md`)) return candidate;
  }
}

async function existingNoteNames(lay: Layout): Promise<Set<string>> {
  try {
    const entries = await fsSource.listFiles(SOURCE_ENV, lay.root, lay.cardDirRel);
    return new Set(entries.filter((e) => e.type === 'file').map((e) => e.name));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return new Set();
    throw err;
  }
}

async function getCardByNoteName(
  lay: Layout,
  noteName: string,
  cfg: Config
): Promise<Card | undefined> {
  const { text, sha } = await readBoard(lay);
  const board = parseBoard(text);
  for (const lane of board.lanes) {
    for (const boardCard of lane.cards) {
      const rc = await resolveCard(lane.name, boardCard, lay, cfg);
      if (rc && basename(rc.noteRel, '.md') === noteName) return toCard(rc, lay, sha, cfg, true);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const obsidian: WorkflowAdapter = {
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
