// @verevoir/workflows/notion — Notion WorkflowAdapter
//
// Maps the WorkflowAdapter contract onto a Notion database used as a
// kanban-shaped tracker. Each row in the database's data source is a
// `Card`; the data source's status / select property provides
// `Column`s.
//
// Notion API v2026: a *database* contains one or more *data sources*.
// For typical kanban-shaped DBs there is exactly one data source —
// the adapter assumes that and uses the first one. Multi-data-source
// boards would need an explicit data-source URL override; not yet
// scoped.
//
// Property mapping is auto-detected from the data source schema at
// runtime so simple boards work zero-config:
//
//   - **Title** → the (mandatory, unique) property typed `title`.
//   - **Column** → the first property typed `status` or `select`
//     (status preferred).
//   - **Assignees** → the first property typed `people`.
//   - **Labels** → the first property typed `multi_select`.
//
// When auto-detect can't map something, operations that depend on it
// throw `WorkflowApiError(501)`. Reads degrade gracefully — unmapped
// fields come back empty.
//
// Body content: each row IS a page. We use Notion's native
// `pages.retrieveMarkdown` / `pages.updateMarkdown` for body
// round-trip — Notion does the block ↔ Markdown conversion itself,
// so we don't need a custom converter here.

import { Client, isFullPage } from '@notionhq/client';
import type {
  CommentObjectResponse,
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints.js';
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

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const BARE_HEX_32 = /^[0-9a-f]{32}$/i;
const PURELY_NUMERIC = /^\d+$/;

/** Parses a Notion database URL or raw ID into a usable identifier.
 *
 * - URL forms (`notion.so/<workspace>/<title>-<32-hex>`, `notion.so/<32-hex>`,
 *   etc.) — the 32-hex segment is extracted and dashified.
 * - Bare 32-hex (no dashes) — dashified to the canonical UUID form.
 * - Anything else that isn't purely numeric — passed through as-is.
 *   The Notion SDK rejects invalid IDs at API-call time; defence-in-
 *   depth at the parser isn't worth the complication. Per Adam
 *   (2026-05-24): "if it's not just a number we use it as is."
 * - Empty / purely-numeric input returns null. */
export function parseNotionDatabaseUrl(input: string): { databaseId: string } | null {
  const trimmed = input.trim().replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/$/, '');
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/notion\.so\/(?:[^/?#]+\/)?(?:.*-)?([0-9a-f]{32})/i);
  if (urlMatch) return { databaseId: dashifyId(urlMatch[1].toLowerCase()) };
  if (BARE_HEX_32.test(trimmed)) return { databaseId: dashifyId(trimmed.toLowerCase()) };
  if (PURELY_NUMERIC.test(trimmed)) return null;
  return { databaseId: trimmed };
}

function dashifyId(id: string): string {
  if (id.includes('-')) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function databaseId(boardUrl: string): string {
  const parsed = parseNotionDatabaseUrl(boardUrl);
  if (!parsed) {
    throw new WorkflowApiError(`Cannot parse Notion database URL: ${boardUrl}`);
  }
  return parsed.databaseId;
}

// ---------------------------------------------------------------------------
// Auth + client
// ---------------------------------------------------------------------------

/** Builds a WorkflowEnv from NOTION_API_KEY. */
export function envFromNotionProcessEnv(): WorkflowEnv | null {
  const token = process.env['NOTION_API_KEY'];
  if (!token) return null;
  return { token };
}

function client(env: WorkflowEnv): Client {
  if (!env.token) {
    throw new WorkflowApiError(
      'Notion integration token not set (env.token is empty; set NOTION_API_KEY)'
    );
  }
  return new Client({ auth: env.token });
}

function mapError(err: unknown, context: string): WorkflowApiError {
  const anyErr = err as { code?: string; status?: number; message?: string };
  if (anyErr?.code === 'object_not_found' || anyErr?.status === 404) {
    return new WorkflowApiError('not_found', 404);
  }
  return new WorkflowApiError(
    `Notion ${context}: ${anyErr?.message ?? String(err)}`,
    anyErr?.status
  );
}

// ---------------------------------------------------------------------------
// Schema / property-mapping auto-detect (lives on a data source)
// ---------------------------------------------------------------------------

interface DbSchema {
  /** Data source ID — what we actually query rows from. */
  dataSourceId: string;
  /** Property name that holds the row's title. */
  titleProp: string;
  /** Property name for the column / status. Undefined when no
   * status / select property exists. */
  statusProp?: string;
  statusType?: 'status' | 'select';
  peopleProp?: string;
  labelsProp?: string;
  /** Full property catalog from the data source — used by
   * `listCustomFields`. Typed as `unknown` because the SDK returns
   * a discriminated union we narrow at use sites. */
  properties: Record<string, NotionPropertySchema>;
}

interface NotionPropertySchema {
  id?: string;
  name?: string;
  type: string;
  status?: { options: Array<{ id: string; name: string; color?: string }> };
  select?: { options: Array<{ id: string; name: string; color?: string }> };
  multi_select?: { options: Array<{ id: string; name: string; color?: string }> };
}

async function fetchSchema(c: Client, dbId: string): Promise<DbSchema> {
  // 1) Database → first data source reference.
  let dataSourceId: string;
  try {
    const db = await c.databases.retrieve({ database_id: dbId });
    const fullDb = db as { data_sources?: Array<{ id: string }> };
    const refs = fullDb.data_sources ?? [];
    if (refs.length === 0) {
      throw new WorkflowApiError(
        `Notion database ${dbId} has no data sources (cannot resolve schema)`
      );
    }
    dataSourceId = refs[0].id;
  } catch (err) {
    if (err instanceof WorkflowApiError) throw err;
    throw mapError(err, `databases.retrieve(${dbId})`);
  }
  // 2) Data source → properties schema.
  let properties: Record<string, NotionPropertySchema>;
  try {
    const ds = await c.dataSources.retrieve({ data_source_id: dataSourceId });
    properties = (ds as { properties: Record<string, NotionPropertySchema> }).properties;
  } catch (err) {
    throw mapError(err, `dataSources.retrieve(${dataSourceId})`);
  }
  // 3) Auto-detect mapping.
  let titleProp: string | undefined;
  let statusProp: string | undefined;
  let statusType: 'status' | 'select' | undefined;
  let peopleProp: string | undefined;
  let labelsProp: string | undefined;
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === 'title' && !titleProp) titleProp = name;
    if (prop.type === 'status' && !statusProp) {
      statusProp = name;
      statusType = 'status';
    }
    if (prop.type === 'people' && !peopleProp) peopleProp = name;
    if (prop.type === 'multi_select' && !labelsProp) labelsProp = name;
  }
  if (!statusProp) {
    for (const [name, prop] of Object.entries(properties)) {
      if (prop.type === 'select') {
        statusProp = name;
        statusType = 'select';
        break;
      }
    }
  }
  if (!titleProp) {
    throw new WorkflowApiError(
      `Notion data source ${dataSourceId} has no title property (every DB must have one)`
    );
  }
  return { dataSourceId, titleProp, statusProp, statusType, peopleProp, labelsProp, properties };
}

// ---------------------------------------------------------------------------
// Card mapping (Notion page → Card)
// ---------------------------------------------------------------------------

function readTitle(page: PageObjectResponse, schema: DbSchema): string {
  const prop = page.properties[schema.titleProp];
  if (prop?.type !== 'title') return '';
  return (prop.title as Array<{ plain_text: string }>).map((s) => s.plain_text).join('');
}

function readStatus(
  page: PageObjectResponse,
  schema: DbSchema
): { id: string; name: string } | null {
  if (!schema.statusProp) return null;
  const prop = page.properties[schema.statusProp];
  if (!prop) return null;
  if (prop.type === 'status' && prop.status) {
    return { id: prop.status.id, name: prop.status.name };
  }
  if (prop.type === 'select' && prop.select) {
    return { id: prop.select.id, name: prop.select.name };
  }
  return null;
}

function readAssignees(page: PageObjectResponse, schema: DbSchema): string[] {
  if (!schema.peopleProp) return [];
  const prop = page.properties[schema.peopleProp];
  if (prop?.type !== 'people') return [];
  return (prop.people as Array<{ id: string }>).map((p) => p.id);
}

function readLabels(page: PageObjectResponse, schema: DbSchema): Label[] {
  if (!schema.labelsProp) return [];
  const prop = page.properties[schema.labelsProp];
  if (prop?.type !== 'multi_select') return [];
  return (prop.multi_select as Array<{ id: string; name: string; color?: string }>).map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.color ? { color: m.color } : {}),
  }));
}

function readDueDate(page: PageObjectResponse): string | undefined {
  for (const [name, prop] of Object.entries(page.properties)) {
    if (!/^(due( date)?|deadline)$/i.test(name)) continue;
    if (prop.type === 'date' && prop.date) return prop.date.start;
  }
  return undefined;
}

async function fetchBodyMarkdown(c: Client, pageId: string): Promise<string> {
  try {
    const resp = await c.pages.retrieveMarkdown({ page_id: pageId });
    return resp.markdown ?? '';
  } catch (err) {
    // If the page has no body content the SDK may 404 the body
    // endpoint; treat that as empty rather than blowing the read.
    const anyErr = err as { code?: string; status?: number };
    if (anyErr?.code === 'object_not_found' || anyErr?.status === 404) return '';
    throw mapError(err, `pages.retrieveMarkdown(${pageId})`);
  }
}

async function mapPageToCard(c: Client, page: PageObjectResponse, schema: DbSchema): Promise<Card> {
  const body = await fetchBodyMarkdown(c, page.id);
  const status = readStatus(page, schema);
  const due = readDueDate(page);
  return {
    id: page.id,
    title: readTitle(page, schema),
    body,
    columnId: status?.id ?? '',
    ...(status?.name ? { columnName: status.name } : {}),
    assigneeIds: readAssignees(page, schema),
    labels: readLabels(page, schema),
    ...(due ? { dueDate: due } : {}),
    url: page.url,
    lastActivity: page.last_edited_time,
  };
}

// ---------------------------------------------------------------------------
// Property write payloads
// ---------------------------------------------------------------------------

function plainRichText(text: string): { type: 'text'; text: { content: string } }[] {
  if (!text) return [];
  return [{ type: 'text', text: { content: text } }];
}

function buildPropertyUpdates(
  patch: CardPatch | CardCreate,
  schema: DbSchema
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if ('title' in patch && patch.title !== undefined) {
    props[schema.titleProp] = { title: plainRichText(patch.title) };
  }
  if (patch.columnId !== undefined) {
    if (!schema.statusProp) {
      throw new WorkflowApiError(
        `Cannot set column on a Notion database with no status / select property`,
        501
      );
    }
    if (schema.statusType === 'status') {
      props[schema.statusProp] = { status: { id: patch.columnId } };
    } else {
      props[schema.statusProp] = { select: { id: patch.columnId } };
    }
  }
  if (patch.assigneeIds !== undefined) {
    if (!schema.peopleProp) {
      throw new WorkflowApiError(
        `Cannot set assignees on a Notion database with no people property`,
        501
      );
    }
    props[schema.peopleProp] = {
      people: patch.assigneeIds.map((id: string) => ({ id })),
    };
  }
  if (patch.labelIds !== undefined) {
    if (!schema.labelsProp) {
      throw new WorkflowApiError(
        `Cannot set labels on a Notion database with no multi_select property`,
        501
      );
    }
    props[schema.labelsProp] = {
      multi_select: patch.labelIds.map((id: string) => ({ id })),
    };
  }
  if (patch.dueDate !== undefined) {
    let dueName: string | undefined;
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (/^(due( date)?|deadline)$/i.test(name) && prop.type === 'date') {
        dueName = name;
        break;
      }
    }
    if (!dueName) {
      throw new WorkflowApiError(
        `Cannot set due date: no date-typed property named Due / Due Date / Deadline found`,
        501
      );
    }
    props[dueName] = { date: { start: patch.dueDate } };
  }
  if (patch.parentId !== undefined) {
    throw new WorkflowApiError(
      'Notion DB rows are flat by default; parentId is not supported',
      501
    );
  }
  return props;
}

// ---------------------------------------------------------------------------
// Adapter methods
// ---------------------------------------------------------------------------

export async function listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  if (!schema.statusProp) return [];
  const prop = schema.properties[schema.statusProp];
  const options =
    prop.type === 'status'
      ? prop.status?.options
      : prop.type === 'select'
        ? prop.select?.options
        : undefined;
  return (options ?? []).map((o, idx) => ({ id: o.id, name: o.name, position: idx }));
}

export async function listCards(
  env: WorkflowEnv,
  boardUrl: string,
  filter?: CardFilter
): Promise<Card[]> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  if (filter?.parentId !== undefined) return [];
  const all: PageObjectResponse[] = [];
  let cursor: string | undefined;
  try {
    do {
      const resp = await c.dataSources.query({
        data_source_id: schema.dataSourceId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const row of resp.results) {
        if (isFullPage(row as PageObjectResponse)) all.push(row as PageObjectResponse);
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
  } catch (err) {
    throw mapError(err, `dataSources.query(${schema.dataSourceId})`);
  }
  const mapped = await Promise.all(all.map((p) => mapPageToCard(c, p, schema)));
  let results = mapped;
  if (filter?.columnId !== undefined) {
    results = results.filter((card) => card.columnId === filter.columnId);
  }
  if (filter?.assigneeId !== undefined) {
    results = results.filter((card) => card.assigneeIds.includes(filter.assigneeId!));
  }
  if (filter?.labelId !== undefined) {
    results = results.filter((card) => card.labels.some((l) => l.id === filter.labelId));
  }
  return results;
}

export async function getCard(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Card> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  try {
    const page = (await c.pages.retrieve({ page_id: cardId })) as PageObjectResponse;
    if (!isFullPage(page)) throw new WorkflowApiError('not_found', 404);
    return await mapPageToCard(c, page, schema);
  } catch (err) {
    throw mapError(err, `pages.retrieve(${cardId})`);
  }
}

export async function isCardFresh(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  version: string
): Promise<boolean> {
  void boardUrl;
  const c = client(env);
  try {
    const page = (await c.pages.retrieve({ page_id: cardId })) as PageObjectResponse;
    if (!isFullPage(page)) return false;
    return page.last_edited_time === version;
  } catch (err) {
    const anyErr = err as { code?: string; status?: number };
    if (anyErr?.code === 'object_not_found' || anyErr?.status === 404) return false;
    throw mapError(err, `isCardFresh(${cardId})`);
  }
}

export async function createCard(
  env: WorkflowEnv,
  boardUrl: string,
  columnId: string,
  fields: CardCreate
): Promise<Card> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  const merged: CardCreate = { ...fields, columnId };
  const properties = buildPropertyUpdates(merged, schema);
  if (!properties[schema.titleProp]) {
    properties[schema.titleProp] = { title: plainRichText(fields.title) };
  }
  try {
    // Notion v2026: create pages with `parent: { data_source_id: ... }`.
    const created = (await c.pages.create({
      parent: { data_source_id: schema.dataSourceId } as never,
      properties: properties as never,
    })) as PageObjectResponse;
    // Body content goes through the dedicated Markdown endpoint, not
    // pages.create's children field — keeps the converter logic in
    // Notion's hands.
    if (fields.body) {
      await c.pages.updateMarkdown({
        page_id: created.id,
        type: 'replace_content',
        replace_content: { markdown: fields.body },
      } as never);
    }
    return await mapPageToCard(c, created, schema);
  } catch (err) {
    throw mapError(err, `pages.create(in ${schema.dataSourceId})`);
  }
}

export async function updateCard(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  patch: CardPatch
): Promise<void> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  const properties = buildPropertyUpdates(patch, schema);
  try {
    if (Object.keys(properties).length > 0) {
      await c.pages.update({ page_id: cardId, properties: properties as never });
    }
    if (patch.body !== undefined) {
      await c.pages.updateMarkdown({
        page_id: cardId,
        type: 'replace_content',
        replace_content: { markdown: patch.body },
      } as never);
    }
  } catch (err) {
    throw mapError(err, `updateCard(${cardId})`);
  }
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
  boardUrl: string,
  cardId: string
): Promise<Comment[]> {
  void boardUrl;
  const c = client(env);
  const all: CommentObjectResponse[] = [];
  let cursor: string | undefined;
  try {
    do {
      const resp = await c.comments.list({ block_id: cardId, start_cursor: cursor });
      for (const comment of resp.results) all.push(comment);
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
  } catch (err) {
    throw mapError(err, `comments.list(${cardId})`);
  }
  return all.map((cmt) => {
    const richText = (cmt.rich_text ?? []) as Array<{ plain_text: string }>;
    const body = richText.map((r) => r.plain_text).join('');
    const author = (cmt.created_by as { id: string } | undefined)?.id ?? '';
    return { id: cmt.id, body, authorName: author, date: cmt.created_time };
  });
}

export async function addComment(
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  body: string
): Promise<void> {
  void boardUrl;
  const c = client(env);
  try {
    await c.comments.create({
      parent: { page_id: cardId },
      rich_text: plainRichText(body) as never,
    });
  } catch (err) {
    throw mapError(err, `comments.create(${cardId})`);
  }
}

export async function listCustomFields(
  env: WorkflowEnv,
  boardUrl: string
): Promise<CustomFieldDef[]> {
  const c = client(env);
  const dbId = databaseId(boardUrl);
  const schema = await fetchSchema(c, dbId);
  const claimed = new Set(
    [schema.titleProp, schema.statusProp, schema.peopleProp, schema.labelsProp].filter(
      Boolean
    ) as string[]
  );
  const out: CustomFieldDef[] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (claimed.has(name)) continue;
    const options = extractOptions(prop);
    out.push({
      id: name,
      name,
      type: mapNotionTypeToCustomFieldType(prop.type),
      ...(options.length > 0 ? { options } : {}),
    });
  }
  return out;
}

function mapNotionTypeToCustomFieldType(type: string): CustomFieldDef['type'] {
  switch (type) {
    case 'rich_text':
    case 'title':
    case 'phone_number':
    case 'email':
    case 'created_time':
    case 'last_edited_time':
    case 'formula':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'select':
    case 'status':
      return 'select';
    case 'multi_select':
      return 'multiselect';
    case 'people':
    case 'created_by':
    case 'last_edited_by':
      return 'user';
    case 'url':
      return 'url';
    default:
      return 'unknown';
  }
}

function extractOptions(
  prop: NotionPropertySchema
): Array<{ id: string; name: string; color?: string }> {
  const opts = prop.status?.options ?? prop.select?.options ?? prop.multi_select?.options ?? [];
  return opts.map((o) => ({ id: o.id, name: o.name, ...(o.color ? { color: o.color } : {}) }));
}

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const notion: WorkflowAdapter = {
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
