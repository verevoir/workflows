// @verevoir/workflows/trello — Trello WorkflowAdapter
//
// Maps the WorkflowAdapter contract onto Trello's REST API v1.
//
// Board > Lists > Cards:
//   - A Trello Board corresponds to the "board" arg (boardUrl)
//   - A Trello List corresponds to Column
//   - A Trello Card corresponds to Card
//
// Auth packing:
//   `WorkflowEnv.token` holds "<apiKey>:<apiToken>" — split on the
//   first ":" because apiTokens may themselves contain ":".
//
// parentId: Trello has no native card hierarchy. Any patch that sets
//   parentId throws WorkflowApiError(501) rather than silently ignoring.

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

const TRELLO_API = 'https://api.trello.com/1';

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/** Parses a Trello board URL into its boardId.
 * Accepts https://trello.com/b/<boardId> or https://trello.com/b/<boardId>/<slug>. */
export function parseTrelloBoardUrl(input: string): { boardId: string } | null {
  const match = input
    .trim()
    .match(/^https?:\/\/(?:www\.)?trello\.com\/b\/([A-Za-z0-9]+)(?:\/[^?#]*)?(?:[?#].*)?$/i);
  if (!match) return null;
  return { boardId: match[1] };
}

function boardId(boardUrl: string): string {
  const parsed = parseTrelloBoardUrl(boardUrl);
  if (!parsed) throw new WorkflowApiError(`Cannot parse Trello board URL: ${boardUrl}`);
  return parsed.boardId;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Builds a WorkflowEnv from TRELLO_API_KEY + TRELLO_API_TOKEN env
 * vars (+ optional TRELLO_REFERER for Power-Up origin matching).
 * Returns null if either credential is absent. */
export function envFromTrelloProcessEnv(): WorkflowEnv | null {
  const key = process.env['TRELLO_API_KEY'];
  const token = process.env['TRELLO_API_TOKEN'];
  if (!key || !token) return null;
  const env: WorkflowEnv = { token: `${key}:${token}` };
  const referer = process.env['TRELLO_REFERER'];
  if (referer) env.referer = referer;
  return env;
}

/** Splits WorkflowEnv.token into apiKey + apiToken on the first ":".
 * Exported so tests can assert the split logic directly. */
export function parseTrelloAuth(env: WorkflowEnv): { apiKey: string; apiToken: string } {
  const idx = env.token.indexOf(':');
  if (idx < 1) {
    throw new WorkflowApiError(
      'Trello token must be "<apiKey>:<apiToken>" — colon not found or apiKey is empty'
    );
  }
  return { apiKey: env.token.slice(0, idx), apiToken: env.token.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function authParams(env: WorkflowEnv): URLSearchParams {
  const { apiKey, apiToken } = parseTrelloAuth(env);
  return new URLSearchParams({ key: apiKey, token: apiToken });
}

async function trelloCall<T>(
  env: WorkflowEnv,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  extraParams?: URLSearchParams
): Promise<T> {
  const params = authParams(env);
  if (extraParams) {
    for (const [k, v] of extraParams) {
      params.set(k, v);
    }
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Trello Power-Up keys are origin-scoped — without a matching
  // Referer the API returns 401.
  if (env.referer) headers['Referer'] = env.referer;

  const res = await fetch(`${TRELLO_API}${path}?${params}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) {
    throw new WorkflowApiError('not_found', 404);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new WorkflowApiError(
      `${method} ${path}: ${res.status}`,
      res.status,
      detail.slice(0, 300)
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Trello response shapes (internal)
// ---------------------------------------------------------------------------

interface TrelloList {
  id: string;
  name: string;
  pos: number;
}

interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}

interface TrelloCard {
  id: string;
  idShort: number;
  name: string;
  desc: string | null;
  idList: string;
  idMembers: string[];
  labels: TrelloLabel[];
  due: string | null;
  url: string;
  dateLastActivity: string;
}

interface TrelloAction {
  id: string;
  date: string;
  data: { text: string };
  memberCreator: { fullName: string };
}

// ---------------------------------------------------------------------------
// Field mapping helpers
// ---------------------------------------------------------------------------

function mapCard(c: TrelloCard, includeBody = true): Card {
  return {
    id: c.id,
    readableId: String(c.idShort),
    title: c.name,
    body: includeBody ? (c.desc ?? '') : '',
    columnId: c.idList,
    assigneeIds: c.idMembers,
    labels: c.labels.map((l) => ({
      id: l.id,
      name: l.name,
      ...(l.color != null ? { color: l.color } : {}),
    })),
    ...(c.due != null ? { dueDate: c.due } : {}),
    url: c.url,
    lastActivity: c.dateLastActivity,
  };
}

// ---------------------------------------------------------------------------
// Adapter methods
// ---------------------------------------------------------------------------

const CARD_FIELDS = 'idShort,name,desc,idList,idMembers,labels,due,url,dateLastActivity';

export async function listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
  const id = boardId(boardUrl);
  const lists = await trelloCall<TrelloList[]>(env, 'GET', `/boards/${id}/lists`);
  return lists
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map((l) => ({ id: l.id, name: l.name, position: l.pos }));
}

export async function listCards(
  env: WorkflowEnv,
  boardUrl: string,
  filter?: CardFilter
): Promise<Card[]> {
  const id = boardId(boardUrl);
  const params = new URLSearchParams({ fields: CARD_FIELDS });
  const cards = await trelloCall<TrelloCard[]>(
    env,
    'GET',
    `/boards/${id}/cards`,
    undefined,
    params
  );
  const includeBody = filter?.includeBody ?? true;
  let results = cards.map((c) => mapCard(c, includeBody));

  // Client-side filtering — consistent regardless of what Trello's server supports at v0.
  if (filter?.columnId !== undefined) {
    results = results.filter((c) => c.columnId === filter.columnId);
  }
  if (filter?.assigneeId !== undefined) {
    results = results.filter((c) => c.assigneeIds.includes(filter.assigneeId!));
  }
  if (filter?.labelId !== undefined) {
    results = results.filter((c) => c.labels.some((l) => l.id === filter.labelId));
  }
  // Trello is flat — no card parents.
  if (filter?.parentId !== undefined) {
    return [];
  }
  if (filter?.limit !== undefined) {
    results = results.slice(0, filter.limit);
  }

  return results;
}

export async function getCard(env: WorkflowEnv, _boardUrl: string, cardId: string): Promise<Card> {
  const params = new URLSearchParams({ fields: CARD_FIELDS });
  const card = await trelloCall<TrelloCard>(env, 'GET', `/cards/${cardId}`, undefined, params);
  return mapCard(card);
}

/** Returns true when the held `version` (a `dateLastActivity`
 * timestamp from a prior `getCard` / `listCards`) still matches the
 * card's current value. One Trello GET requesting only the
 * `dateLastActivity` field — the cheapest probe the API offers.
 * 404 (card deleted / moved out of scope) maps to false. */
export async function isCardFresh(
  env: WorkflowEnv,
  _boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  const params = new URLSearchParams({ fields: 'dateLastActivity' });
  try {
    const data = await trelloCall<{ dateLastActivity?: string }>(
      env,
      'GET',
      `/cards/${cardId}`,
      undefined,
      params
    );
    return data.dateLastActivity === version;
  } catch (err) {
    if (err instanceof WorkflowApiError && err.status === 404) return false;
    throw err;
  }
}

export async function createCard(
  env: WorkflowEnv,
  _boardUrl: string,
  columnId: string,
  fields: CardCreate
): Promise<Card> {
  if (fields.parentId !== undefined) {
    throw new WorkflowApiError(
      'Trello does not support hierarchical cards; parentId cannot be set',
      501
    );
  }
  const body: Record<string, unknown> = {
    idList: columnId,
    name: fields.title,
  };
  if (fields.body !== undefined) body['desc'] = fields.body;
  if (fields.assigneeIds !== undefined) body['idMembers'] = fields.assigneeIds;
  if (fields.labelIds !== undefined) body['idLabels'] = fields.labelIds;
  if (fields.dueDate !== undefined) body['due'] = fields.dueDate;

  const created = await trelloCall<TrelloCard>(env, 'POST', '/cards', body);
  return mapCard(created);
}

export async function updateCard(
  env: WorkflowEnv,
  _boardUrl: string,
  cardId: string,
  patch: CardPatch
): Promise<void> {
  if (patch.parentId !== undefined) {
    throw new WorkflowApiError(
      'Trello does not support hierarchical cards; parentId cannot be set',
      501
    );
  }
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body['name'] = patch.title;
  if (patch.body !== undefined) body['desc'] = patch.body;
  if (patch.columnId !== undefined) body['idList'] = patch.columnId;
  if (patch.assigneeIds !== undefined) body['idMembers'] = patch.assigneeIds;
  if (patch.labelIds !== undefined) body['idLabels'] = patch.labelIds;
  if (patch.dueDate !== undefined) body['due'] = patch.dueDate;

  await trelloCall<unknown>(env, 'PUT', `/cards/${cardId}`, body);
}

export async function moveCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  toColumnId: string
): Promise<void> {
  return updateCard(env, boardUrl, cardId, { columnId: toColumnId });
}

export async function listComments(
  env: WorkflowEnv,
  _boardUrl: string,
  cardId: string
): Promise<Comment[]> {
  const params = new URLSearchParams({ filter: 'commentCard', limit: '50' });
  const actions = await trelloCall<TrelloAction[]>(
    env,
    'GET',
    `/cards/${cardId}/actions`,
    undefined,
    params
  );
  return actions.map((a) => ({
    id: a.id,
    body: a.data.text,
    authorName: a.memberCreator.fullName,
    date: a.date,
  }));
}

export async function addComment(
  env: WorkflowEnv,
  _boardUrl: string,
  cardId: string,
  body: string
): Promise<void> {
  await trelloCall<unknown>(env, 'POST', `/cards/${cardId}/actions/comments`, { text: body });
}

/** Returns [] at v0. Trello's Custom Fields Power-Up exposes a
 * separate `/boards/<id>/customFields` endpoint; wiring that up is
 * a v0.2 concern. Most boards don't use the Power-Up. */
export async function listCustomFields(
  _env: WorkflowEnv,
  _boardUrl: string
): Promise<CustomFieldDef[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const trello: WorkflowAdapter = {
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
