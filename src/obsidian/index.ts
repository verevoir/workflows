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
// No credentials. Behaviour is tuned via env vars (read at call time):
//   OBSIDIAN_VAULT_PATH   vault root for wikilink fallback resolution
//   OBSIDIAN_ID_FIELD     identity frontmatter field (default "id")
//   OBSIDIAN_CARD_FOLDER  where createCard writes notes (default: board dir)
//   OBSIDIAN_DATE_FIELD   due-date frontmatter field (default "due")
//   OBSIDIAN_TAGS_FIELD   labels frontmatter field (default "tags")

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Path parsing + config
// ---------------------------------------------------------------------------

/** Resolves a boardUrl (absolute path or file:// URL) to a file path.
 * Returns null for relative paths — the seam where a future
 * sources-backed variant would slot in. */
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
// Board file I/O (the seam — local FS only for now)
// ---------------------------------------------------------------------------

function readBoardFile(boardUrl: string): { filePath: string; text: string; mtimeMs: number } {
  const parsed = parseObsidianBoardPath(boardUrl);
  if (!parsed) throw new WorkflowApiError(`Cannot parse Obsidian board path: ${boardUrl}`);
  if (!existsSync(parsed.filePath)) {
    throw new WorkflowApiError(`Board file not found: ${parsed.filePath}`, 404);
  }
  return {
    filePath: parsed.filePath,
    text: readFileSync(parsed.filePath, 'utf8'),
    mtimeMs: statSync(parsed.filePath).mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Card resolution + mapping
// ---------------------------------------------------------------------------

interface ResolvedCard {
  laneName: string;
  boardCard: BoardCard;
  notePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Walks the board's link cards, resolves each to a note, and keeps only
 * those carrying an id field. */
function resolveCards(board: Board, boardDir: string, cfg: Config): ResolvedCard[] {
  const out: ResolvedCard[] = [];
  for (const lane of board.lanes) {
    for (const boardCard of lane.cards) {
      if (!boardCard.link) continue;
      const notePath = resolveWikilink(boardCard.link.target, {
        boardDir,
        ...(cfg.cardFolder ? { cardDir: cfg.cardFolder } : {}),
        ...(cfg.vaultRoot ? { vaultRoot: cfg.vaultRoot } : {}),
      });
      if (!notePath || !existsSync(notePath)) continue;
      const { frontmatter, body } = parseNote(readFileSync(notePath, 'utf8'));
      const id = frontmatter[cfg.idField];
      if (id == null || String(id).trim() === '') continue;
      out.push({ laneName: lane.name, boardCard, notePath, frontmatter, body });
    }
  }
  return out;
}

function readLabels(frontmatter: Record<string, unknown>, cfg: Config): Label[] {
  const raw = frontmatter[cfg.tagsField];
  const tags = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return tags.map((t) => ({ id: String(t), name: String(t) }));
}

function toCard(rc: ResolvedCard, boardMtimeMs: number, cfg: Config, includeBody: boolean): Card {
  const id = String(rc.frontmatter[cfg.idField]);
  const titleField = rc.frontmatter['title'];
  const title =
    titleField != null && String(titleField).trim() !== ''
      ? String(titleField)
      : basename(rc.notePath, '.md');
  const due = rc.frontmatter[cfg.dateField];
  const noteMtimeMs = statSync(rc.notePath).mtimeMs;
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
    url: pathToFileURL(rc.notePath).href,
    lastActivity: `${noteMtimeMs}|${boardMtimeMs}`,
  };
}

function findById(
  board: Board,
  boardDir: string,
  cfg: Config,
  cardId: string
): ResolvedCard | undefined {
  return resolveCards(board, boardDir, cfg).find(
    (rc) => String(rc.frontmatter[cfg.idField]) === cardId
  );
}

// ---------------------------------------------------------------------------
// Adapter methods
// ---------------------------------------------------------------------------

export async function listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
  void env;
  const { text } = readBoardFile(boardUrl);
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
  const { filePath, text, mtimeMs } = readBoardFile(boardUrl);
  const cfg = config();
  const board = parseBoard(text);
  const includeBody = filter?.includeBody ?? true;
  let cards = resolveCards(board, dirname(filePath), cfg).map((rc) =>
    toCard(rc, mtimeMs, cfg, includeBody)
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
  const { filePath, text, mtimeMs } = readBoardFile(boardUrl);
  const cfg = config();
  const rc = findById(parseBoard(text), dirname(filePath), cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);
  return toCard(rc, mtimeMs, cfg, true);
}

export async function isCardFresh(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  void env;
  const { filePath, text, mtimeMs } = readBoardFile(boardUrl);
  const cfg = config();
  const rc = findById(parseBoard(text), dirname(filePath), cfg, cardId);
  if (!rc) return false;
  return version === `${statSync(rc.notePath).mtimeMs}|${mtimeMs}`;
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
  const { filePath, text } = readBoardFile(boardUrl);
  const cfg = config();
  const board = parseBoard(text);
  const lane = board.lanes.find((l) => l.name === columnId);
  if (!lane) throw new WorkflowApiError(`Column not found: ${columnId}`, 404);

  const boardDir = dirname(filePath);
  const folder = cfg.cardFolder ?? boardDir;
  const noteName = uniqueNoteName(folder, fields.title);
  const frontmatter: Record<string, unknown> = { [cfg.idField]: randomUUID() };
  if (fields.title) frontmatter['title'] = fields.title;
  if (fields.labelIds) frontmatter[cfg.tagsField] = fields.labelIds;
  if (fields.dueDate) frontmatter[cfg.dateField] = fields.dueDate;
  writeFileSync(join(folder, `${noteName}.md`), serializeNote(frontmatter, fields.body ?? ''));

  lane.cards.push({ rawLine: `- [ ] [[${noteName}]]`, checked: false, link: { target: noteName } });
  writeFileSync(filePath, serializeBoard(board));

  const created = await getCardByNoteName(boardUrl, noteName, cfg);
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
  const { filePath, text } = readBoardFile(boardUrl);
  const cfg = config();
  const board = parseBoard(text);
  const rc = findById(board, dirname(filePath), cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);

  const fmUpdates: Record<string, unknown> = {};
  if (patch.title !== undefined) fmUpdates['title'] = patch.title;
  if (patch.labelIds !== undefined) fmUpdates[cfg.tagsField] = patch.labelIds;
  if (patch.dueDate !== undefined) fmUpdates[cfg.dateField] = patch.dueDate;

  let noteText = readFileSync(rc.notePath, 'utf8');
  if (Object.keys(fmUpdates).length > 0) noteText = editNoteFrontmatter(noteText, fmUpdates);
  if (patch.body !== undefined) noteText = setNoteBody(noteText, patch.body);
  writeFileSync(rc.notePath, noteText);

  if (patch.columnId !== undefined && patch.columnId !== rc.laneName) {
    moveBoardCard(board, rc.boardCard, patch.columnId);
    writeFileSync(filePath, serializeBoard(board));
  }
}

export async function moveCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  toColumnId: string
): Promise<void> {
  void env;
  const { filePath, text } = readBoardFile(boardUrl);
  const cfg = config();
  const board = parseBoard(text);
  const rc = findById(board, dirname(filePath), cfg, cardId);
  if (!rc) throw new WorkflowApiError(`Card not found: ${cardId}`, 404);
  moveBoardCard(board, rc.boardCard, toColumnId);
  writeFileSync(filePath, serializeBoard(board));
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

function uniqueNoteName(folder: string, title: string): string {
  const safe = (title || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Untitled';
  if (!existsSync(join(folder, `${safe}.md`))) return safe;
  for (let n = 1; ; n++) {
    const candidate = `${safe} ${n}`;
    if (!existsSync(join(folder, `${candidate}.md`))) return candidate;
  }
}

async function getCardByNoteName(
  boardUrl: string,
  noteName: string,
  cfg: Config
): Promise<Card | undefined> {
  const { filePath, text, mtimeMs } = readBoardFile(boardUrl);
  const rc = resolveCards(parseBoard(text), dirname(filePath), cfg).find(
    (c) => basename(c.notePath, '.md') === noteName
  );
  return rc ? toCard(rc, mtimeMs, cfg, true) : undefined;
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
