// @verevoir/workflows/asf — ASF Platform WorkflowAdapter.
//
// Task -> Card. BOARD_COLUMNS (backlog, ready, in-progress,
// awaiting-human-review, done) is a closed, server-fixed set with no
// list-columns route, so listColumns returns it directly, with no network
// call.
//
// Space id comes from AsfEnv.spaceId, not boardUrl — ASF spaces aren't named
// by a URL the way a Trello board or a Backlog directory is. boardUrl is
// accepted (the contract requires it) and ignored.
//
// Confirmed against packages/contracts/src/task.ts at reference time, not
// guessed: Task has no description field (Card.body stays '') and no parent
// field (parentId stays undefined — ASF tasks are flat). `revision` is the
// board's own optimistic-concurrency handle; reused here as Card.lastActivity
// and isCardFresh's version, since ASF exposes no narrower freshness probe.
//
// createCard is POST /api/spaces/{s}/resources, and updateCard is PUT
// /api/spaces/{s}/resources/{id} — NOT under tasks/, which exports GET only.
// Confirmed against resources/route.ts and resources/[id]/route.ts: a JSON
// body with no `content` key is the "fields form", a task's own
// (TaskFieldsCreateBodySchema / TaskFieldsUpdateBodySchema,
// packages/contracts/src/taskFields.ts, both `.strict()`). Create takes
// {subtype, title, body, properties} (all required) plus optional {key,
// column}; update takes any non-empty subset of {subtype, title, body,
// properties} and refuses column entirely — a column change goes through
// moveCard, exactly as the SDK's own editTask does (edit first, then an
// unconditional move). update also needs an `If-Match` ETag, which only the
// resources/{id} GET returns (the tasks/{id} GET does not), so updateCard
// fetches it fresh rather than deriving one from Task.revision.
//
// Fields this adapter's contract has no mapping for (assigneeIds, labelIds,
// dueDate, parentId, customFields) are refused by name — ASF's task-fields
// schema has no such keys, and this is the "absence is loud" convention the
// platform's own code follows throughout, not a staging gap.
//
// moveCard is the one write route under tasks/ (.../tasks/[taskId]/moves):
// it reads the task's current revision, POSTs the move conditioned on it,
// and on a genuine revision race (409, distinct from an archived-task 409 by
// the server's own details.reason) refetches and retries up to
// ASF_MOVE_MAX_ATTEMPTS times before giving up with a named
// WorkflowApiError(409).
//
// listComments/addComment/listCustomFields: confirmed against the full
// app/api/spaces/[spaceId]/* route tree (archive, assets, claims, grants,
// pages, resources, run-requests, tasks) — no comment route and no
// field-schema route exist anywhere. TaskPropertiesSchema (packages/
// contracts/src/taskFields.ts) is z.record(string, unknown): a free-form
// bag with no listable field definitions, not merely an unimplemented one.
// listComments/listCustomFields degrade to empty reads, and addComment
// refuses — the same split Obsidian and Backlog already use for a
// capability their own backend has no equivalent for at all.
//
// Every path segment built from spaceId or cardId is encodeURIComponent'd —
// both can be arbitrary platform-assigned strings, not guaranteed URL-safe.

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
import { renewingToken, staticToken, type TokenProvider } from './token.js';

/** The five ASF board columns, in their platform-defined order. */
export const ASF_BOARD_COLUMNS = [
  'backlog',
  'ready',
  'in-progress',
  'awaiting-human-review',
  'done',
] as const;

export interface AsfEnv extends WorkflowEnv {
  readonly baseUrl: string;
  readonly spaceId: string;
  readonly tokenProvider: TokenProvider;
  readonly fetch?: typeof fetch;
}

/** Builds an AsfEnv from ASF_PLATFORM_BASE_URL, ASF_SPACE_ID, and either
 * ASF_TOKEN (static) or ASF_CREDENTIALS_FILE (renewing — see token.ts).
 * Returns null when baseUrl, spaceId, or a credential source is absent. */
export function envFromAsfProcessEnv(): AsfEnv | null {
  const baseUrl = process.env['ASF_PLATFORM_BASE_URL'];
  const spaceId = process.env['ASF_SPACE_ID'];
  if (!baseUrl || !spaceId) return null;

  const staticValue = process.env['ASF_TOKEN'];
  const credentialsFile = process.env['ASF_CREDENTIALS_FILE'];
  let tokenProvider: TokenProvider;
  if (staticValue) {
    tokenProvider = staticToken(staticValue);
  } else if (credentialsFile) {
    tokenProvider = renewingToken({ baseUrl, credentialsFile });
  } else {
    return null;
  }
  return { token: '', baseUrl, spaceId, tokenProvider };
}

/** Every asf function receives an AsfEnv, not a bare WorkflowEnv — checked
 * here so a caller gets a named refusal instead of a malformed request URL
 * built from missing fields later. */
function asfEnv(env: WorkflowEnv): AsfEnv {
  const asf = env as AsfEnv;
  if (!asf.baseUrl || !asf.spaceId || typeof asf.tokenProvider !== 'function') {
    throw new WorkflowApiError(
      'asf adapter requires an AsfEnv (baseUrl, spaceId, tokenProvider) — build one with envFromAsfProcessEnv() or directly'
    );
  }
  return asf;
}

interface AsfTask {
  id: string;
  key: string;
  title: string;
  column: string;
  revision?: string;
  assignee?: { id?: string };
}

async function asfCall<T>(
  env: AsfEnv,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const doFetch = env.fetch ?? fetch;
  const token = await env.tokenProvider();
  const res = await doFetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 404) throw new WorkflowApiError('not_found', 404);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Not JSON — message already falls back to statusText above.
    }
    throw new WorkflowApiError(`${method} ${path}: ${message}`, res.status, text.slice(0, 300));
  }
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

function mapCard(task: AsfTask): Card {
  return {
    id: task.id,
    readableId: task.key,
    title: task.title,
    body: '',
    columnId: task.column,
    columnName: task.column,
    assigneeIds: task.assignee?.id ? [task.assignee.id] : [],
    labels: [],
    ...(task.revision !== undefined ? { lastActivity: task.revision } : {}),
  };
}

export async function listColumns(_env: WorkflowEnv, _boardUrl: string): Promise<Column[]> {
  return ASF_BOARD_COLUMNS.map((name, position) => ({ id: name, name, position }));
}

export async function listCards(
  env: WorkflowEnv,
  _boardUrl: string,
  filter?: CardFilter
): Promise<Card[]> {
  // ASF is flat — no card hierarchy — mirroring trello/index.ts's convention
  // for a flat backend: a parentId filter can only ever match nothing.
  if (filter?.parentId !== undefined) return [];

  const asf = asfEnv(env);
  const path =
    filter?.columnId !== undefined
      ? `/api/spaces/${encodeURIComponent(asf.spaceId)}/tasks?column=${encodeURIComponent(filter.columnId)}`
      : `/api/spaces/${encodeURIComponent(asf.spaceId)}/tasks`;
  const { tasks } = await asfCall<{ tasks: AsfTask[] }>(asf, 'GET', path);
  let cards = tasks.map(mapCard);
  if (filter?.assigneeId !== undefined) {
    cards = cards.filter((c) => c.assigneeIds.includes(filter.assigneeId as string));
  }
  if (filter?.limit !== undefined) cards = cards.slice(0, filter.limit);
  return cards;
}

export async function getCard(env: WorkflowEnv, _boardUrl: string, cardId: string): Promise<Card> {
  const asf = asfEnv(env);
  const task = await asfCall<AsfTask>(
    asf,
    'GET',
    `/api/spaces/${encodeURIComponent(asf.spaceId)}/tasks/${encodeURIComponent(cardId)}`
  );
  return mapCard(task);
}

/** Re-reads the card and compares `revision` — ASF has no field-select param
 * on this route, so there is no cheaper probe than a full read. */
export async function isCardFresh(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  try {
    const card = await getCard(env, boardUrl, cardId);
    return card.lastActivity === version;
  } catch (err) {
    if (err instanceof WorkflowApiError && err.status === 404) return false;
    throw err;
  }
}

/** Fields this adapter's contract offers that ASF's task-fields schema
 * (TaskFieldsCreateBodySchema / TaskFieldsUpdateBodySchema) has no slot for
 * at all — refused by name rather than silently dropped. */
const ASF_UNMAPPED_FIELDS = [
  'assigneeIds',
  'labelIds',
  'dueDate',
  'parentId',
  'customFields',
] as const;

function refuseUnmappedFields(fields: CardCreate | CardPatch): void {
  for (const name of ASF_UNMAPPED_FIELDS) {
    if ((fields as Record<string, unknown>)[name] !== undefined) {
      throw new WorkflowApiError(
        `ASF's task fields contract has no "${name}" (TaskFieldsCreateBodySchema / TaskFieldsUpdateBodySchema accept only subtype, title, body and properties)`,
        501
      );
    }
  }
}

/** TaskNameSchema (packages/contracts/src/taskFields.ts) is a trimmed,
 * non-empty string — any non-empty subtype satisfies it. 'story' mirrors
 * the SDK's own default (adapter-core/src/tools/tasks.ts, createTask), the
 * one value this platform's own tools have proven the schema accepts. */
const ASF_DEFAULT_SUBTYPE = 'story';

/** TaskPropertiesSchema is z.record(z.string(), z.unknown()) — an empty map
 * is a valid value (confirmed: no .nonempty()/.refine() on it), so this
 * adds no implicit policy (unlike the SDK's own default,
 * {authority:'prescriptive'}, which is deliberately NOT mirrored here: that
 * value encodes an ASF-specific operational policy, not a schema minimum). */
const ASF_DEFAULT_PROPERTIES = {};

export async function createCard(
  env: WorkflowEnv,
  boardUrl: string,
  columnId: string,
  fields: CardCreate
): Promise<Card> {
  refuseUnmappedFields(fields);
  const asf = asfEnv(env);
  const created = await asfCall<{ id: string }>(
    asf,
    'POST',
    `/api/spaces/${encodeURIComponent(asf.spaceId)}/resources`,
    {
      subtype: ASF_DEFAULT_SUBTYPE,
      title: fields.title,
      body: fields.body ?? '',
      properties: ASF_DEFAULT_PROPERTIES,
      column: columnId,
    }
  );
  // The create route (/resources) answers a page-shaped wrapper, not the bare
  // Task shape — reading the id back and re-fetching through the already-
  // proven tasks/{id} route (getCard) is safer than parsing that wrapper's
  // own, differently-shaped fields.
  return getCard(env, boardUrl, created.id);
}

/** Only resources/{id}'s GET returns an ETag (tasks/{id}'s GET does not) —
 * fetched fresh rather than derived from Task.revision, since the exact
 * ETag transform (etagForRevision, control-plane/src/lib/page-representation.ts)
 * is not part of this adapter's reference material. */
async function etagForCard(asf: AsfEnv, cardId: string): Promise<string> {
  const doFetch = asf.fetch ?? fetch;
  const token = await asf.tokenProvider();
  const res = await doFetch(
    `${asf.baseUrl}/api/spaces/${encodeURIComponent(asf.spaceId)}/resources/${encodeURIComponent(cardId)}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }
  );
  if (res.status === 404) throw new WorkflowApiError('not_found', 404);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WorkflowApiError(
      `GET /resources/${cardId}: ${res.statusText}`,
      res.status,
      text.slice(0, 300)
    );
  }
  const etag = res.headers.get('etag');
  if (!etag) {
    throw new WorkflowApiError(
      `ASF returned no ETag for task ${cardId}; updateCard cannot safely write without one (If-Match is required)`
    );
  }
  return etag;
}

export async function updateCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  patch: CardPatch
): Promise<void> {
  refuseUnmappedFields(patch);
  const asf = asfEnv(env);
  const fields: Record<string, unknown> = {};
  if (patch.title !== undefined) fields['title'] = patch.title;
  if (patch.body !== undefined) fields['body'] = patch.body;
  if (Object.keys(fields).length > 0) {
    const etag = await etagForCard(asf, cardId);
    await asfCall<unknown>(
      asf,
      'PUT',
      `/api/spaces/${encodeURIComponent(asf.spaceId)}/resources/${encodeURIComponent(cardId)}`,
      fields,
      { 'if-match': etag }
    );
  }
  // column is not a field TaskFieldsUpdateBodySchema accepts at all (it is a
  // refused, unrecognized key there) — a column change goes through the
  // moves route, after the edit above, unconditionally, exactly as the SDK's
  // own editTask does it (edit first, then the move, never the reverse).
  if (patch.columnId !== undefined) {
    await moveCard(env, boardUrl, cardId, patch.columnId);
  }
}

const ASF_MOVE_MAX_ATTEMPTS = 3;

/** True only for the server's archived-task 409 (details.reason ===
 * 'archived'), distinct from a racing-move 409 — retrying an archived
 * conflict can't succeed, since the column won't change on its own. A
 * truncated 409 body (asfCall slices detail to 300 chars) or one that
 * is not valid JSON at all is treated the same as a non-archived
 * conflict — the single try/catch below wraps both JSON.parse and the
 * subsequent property-reads, so a parse failure, a non-object result,
 * or a null result all fall through to `false` rather than throwing;
 * moveCard's bounded retry then runs exactly as it would for any other
 * non-archived 409, instead of being silently skipped. */
function isArchivedConflict(err: unknown): boolean {
  if (!(err instanceof WorkflowApiError) || err.status !== 409 || !err.detail) return false;
  try {
    const parsed = JSON.parse(err.detail) as { error?: { details?: { reason?: string } } };
    return parsed.error?.details?.reason === 'archived';
  } catch {
    return false;
  }
}

export async function moveCard(
  env: WorkflowEnv,
  _boardUrl: string,
  cardId: string,
  toColumnId: string
): Promise<void> {
  const asf = asfEnv(env);
  const path = `/api/spaces/${encodeURIComponent(asf.spaceId)}/tasks/${encodeURIComponent(cardId)}`;
  for (let attempt = 1; attempt <= ASF_MOVE_MAX_ATTEMPTS; attempt++) {
    const current = await asfCall<AsfTask>(asf, 'GET', path);
    try {
      await asfCall<AsfTask>(asf, 'POST', `${path}/moves`, {
        column: toColumnId,
        ...(current.revision !== undefined ? { expectedRevision: current.revision } : {}),
      });
      return;
    } catch (err) {
      if (!(err instanceof WorkflowApiError) || err.status !== 409 || isArchivedConflict(err)) {
        throw err;
      }
      if (attempt === ASF_MOVE_MAX_ATTEMPTS) {
        throw new WorkflowApiError(
          `moveCard: the task kept changing underneath this move after ${ASF_MOVE_MAX_ATTEMPTS} attempts`,
          409
        );
      }
    }
  }
}

/** ASF has no comment route anywhere under app/api/spaces/[spaceId]/* —
 * reads degrade to empty, matching Obsidian's and Backlog's own "no
 * equivalent" convention for a capability the backend entirely lacks. */
export async function listComments(
  _env: WorkflowEnv,
  _boardUrl: string,
  _cardId: string
): Promise<Comment[]> {
  return [];
}

export async function addComment(
  _env: WorkflowEnv,
  _boardUrl: string,
  _cardId: string,
  _body: string
): Promise<void> {
  throw new WorkflowApiError(
    'ASF has no comment route under app/api/spaces/[spaceId]/tasks or /resources',
    501
  );
}

/** ASF's task properties (TaskPropertiesSchema, packages/contracts/src/
 * taskFields.ts) are z.record(string, unknown) — a free-form bag with no
 * listable field schema, and no route exposes one. [] matches Trello's own
 * convention for "no custom-field concept" (README: "Adapters that don't
 * support custom fields... return [] ... and leave Card.customFields
 * undefined"). */
export async function listCustomFields(
  _env: WorkflowEnv,
  _boardUrl: string
): Promise<CustomFieldDef[]> {
  return [];
}

export const asf: WorkflowAdapter = {
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
