// @verevoir/workflows/asf — ASF Platform WorkflowAdapter (PR A: auth + reads).
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

import {
  WorkflowApiError,
  type Card,
  type CardFilter,
  type Column,
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
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const doFetch = env.fetch ?? fetch;
  const token = await env.tokenProvider();
  const res = await doFetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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
      ? `/api/spaces/${asf.spaceId}/tasks?column=${encodeURIComponent(filter.columnId)}`
      : `/api/spaces/${asf.spaceId}/tasks`;
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
  const task = await asfCall<AsfTask>(asf, 'GET', `/api/spaces/${asf.spaceId}/tasks/${cardId}`);
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
