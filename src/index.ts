// @verevoir/workflows — contract module
//
// A `WorkflowAdapter` is a thin client over a workflow source —
// kanban boards, issue trackers, structured task systems. Today
// only the Trello adapter ships (`@verevoir/workflows/trello`);
// Jira, Linear, Notion databases, GitHub Issues/Projects, and an
// in-aigency wrapper over the objective tree follow under the same
// contract.
//
// The contract assumes ANY workflow source will be one of the
// implementations — including aigency's own objectives. Designs
// that bake in one tool's idioms (Trello "lists", Jira "statuses",
// Notion "select options") would break that symmetry. So the
// contract uses neutral names — `Column` is whatever the backend
// calls its workflow state, `Label` whatever it calls its tags.
//
// Read-only adapters implement the read half (listColumns,
// listCards, getCard, listComments) and skip the write half.
// Read+write adapters implement everything.

/** Auth + config shared across calls to a workflow adapter.
 *
 * Each adapter packs its own auth shape into `token`. Examples:
 *   - Trello: `"<apiKey>:<apiToken>"` (split on first `:`)
 *   - Jira:   `"<email>:<api-token>"` (basic auth pattern)
 *   - Notion: `"<integration-token>"` (single value)
 *   - Linear: `"<api-key>"` (single value)
 *
 * The adapter parses its env internally. Helpers like
 * `envFromTrelloProcessEnv()` build a valid env from process.env. */
export interface WorkflowEnv {
  token: string;
  /** Optional origin signal for adapters that require it. Trello
   * Power-Up keys are scoped to allowed referrers; server-side
   * callers MUST set this to a value that matches the Power-Up's
   * origin or all calls 401. Adapters that don't need it ignore. */
  referer?: string;
}

/** Error type for workflow API failures. `status` mirrors HTTP
 * semantics where applicable: 404 for missing card / board / column,
 * 401/403 for auth, 501 for "this adapter doesn't support that
 * operation". */
export class WorkflowApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string
  ) {
    super(message);
    this.name = 'WorkflowApiError';
  }
}

// ===========================================================
// Domain types
// ===========================================================

/** A workflow column — a state cards move through. Trello list,
 * Jira status, Notion DB option, aigency objective phase. */
export interface Column {
  id: string;
  name: string;
  /** Ordering within the board, when the backend exposes it.
   * Absent for sources that don't support reordering. */
  position?: number;
}

/** A label / tag attached to a card. */
export interface Label {
  id: string;
  name: string;
  /** Advisory only — backend-specific colour token (e.g. Trello's
   * 'green', Jira's hex) for UI rendering. Consumers MUST tolerate
   * unknown colours. */
  color?: string;
}

/** A workflow card. Same shape across Trello card, Jira issue,
 * Notion DB row, aigency objective. */
export interface Card {
  id: string;
  /** Human-readable identifier when the backend has one — Trello
   * card number (`idShort`), Jira issue key, Linear identifier,
   * Notion's `ID` property when configured, etc. Distinct from `id`
   * (the stable record identifier the adapter uses for API calls)
   * because the readable form is what humans paste into commits,
   * branch names, and PR titles. Absent when the backend has no
   * such concept or the adapter hasn't been told where to find it. */
  readableId?: string;
  title: string;
  /** Markdown body. Empty string when the card has no description. */
  body: string;
  columnId: string;
  /** Denormalised column name — populated when the adapter has it
   * cheap. Consumers should treat as advisory; columnId is the
   * source of truth. */
  columnName?: string;
  /** Parent card ID for hierarchical workflows — Jira sub-tasks
   * under epics, Notion nested rows, aigency sub-objectives.
   * Absent for flat backends (Trello). Consumers reconstruct the
   * tree by walking parentId pointers across `listCards` results. */
  parentId?: string;
  /** Backend-specific member / user IDs. Resolution to display
   * names is out of contract scope; consumers that need names
   * call the backend (or a directory service) separately. */
  assigneeIds: string[];
  labels: Label[];
  /** ISO8601. Optional — not every backend tracks due dates. */
  dueDate?: string;
  /** Permalink to the card in the backend's UI, when the backend
   * exposes one. */
  url?: string;
  /** ISO8601 timestamp of the last activity on the card. Opaque
   * change handle — useful as a cache key. */
  lastActivity?: string;
  /** Backend-specific custom fields, keyed by field ID. Empty (or
   * absent) when the backend has none or when the adapter hasn't
   * fetched them. Consumers cross-reference the keys against
   * `listCustomFields` to know what each field is. */
  customFields?: Record<string, CustomFieldValue>;
}

/** A comment on a card. */
export interface Comment {
  id: string;
  body: string;
  /** Display name of the comment author, as the backend provides
   * it. May be empty when the backend doesn't include it on the
   * comment payload. */
  authorName: string;
  /** ISO8601. */
  date: string;
}

// ===========================================================
// Custom fields — the extensibility surface
// ===========================================================

/** Custom-field value union. Sources tag values with a `type` so
 * consumers can render or filter without re-introspecting the field
 * definition. `'unknown'` is the safety valve for field types this
 * version of the contract doesn't know about — adapters MUST emit
 * it rather than dropping the field. */
export type CustomFieldValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'date'; value: string /* ISO8601 */ }
  | { type: 'checkbox'; value: boolean }
  | { type: 'select'; value: { id: string; name: string } | null }
  | { type: 'multiselect'; value: Array<{ id: string; name: string }> }
  | { type: 'user'; value: string[] /* user IDs */ }
  | { type: 'url'; value: string }
  | { type: 'unknown'; value: unknown };

/** Definition of a custom field available on a board. Returned by
 * `listCustomFields`. Consumers use this to render edit UIs and to
 * validate `CardPatch.customFields` values against the schema. */
export interface CustomFieldDef {
  id: string;
  name: string;
  type: CustomFieldValue['type'];
  /** For select / multiselect fields — the available options. */
  options?: Array<{ id: string; name: string; color?: string }>;
}

// ===========================================================
// Filter / patch types
// ===========================================================

/** Filter passed to `listCards`. Adapters MUST honour the filter
 * server-side when the backend supports it, and fall back to
 * client-side filtering otherwise — consumers see the same shape
 * either way. */
export interface CardFilter {
  /** Restrict to cards in this column. */
  columnId?: string;
  /** Restrict to cards where this user is an assignee. */
  assigneeId?: string;
  /** Restrict to cards carrying this label. */
  labelId?: string;
  /** Restrict to direct children of this card. Hierarchical
   * backends use this for sub-tree reads; flat backends MAY return
   * an empty array (no children possible) or honour-as-no-op. */
  parentId?: string;
  /** Include each card's Markdown `body`. Default **true**. Set
   * `false` for list views to skip body fetches — on Notion that's
   * one API call per row — and keep the payload small; fetch a single
   * body on demand with `getCard`. When false, `Card.body` is `''`. */
  includeBody?: boolean;
  /** Cap the number of cards returned (applied after filtering).
   * Omit for no cap. */
  limit?: number;
}

/** Patch shape for `updateCard`. Only the fields present in the
 * patch are touched; absent fields are left as-is. Setting an
 * optional field to `undefined` MUST be ignored, not interpreted as
 * "clear" — consumers that need to clear use `null` once we add
 * clear semantics, or omit until then. */
export interface CardPatch {
  title?: string;
  body?: string;
  /** Setting this moves the card to a new column. Equivalent to
   * `moveCard(cardId, columnId)` — the standalone method exists for
   * discoverability. */
  columnId?: string;
  /** Setting this re-parents the card. Backends that don't support
   * hierarchy (Trello) MUST throw WorkflowApiError on a non-undefined
   * value rather than silently ignoring. */
  parentId?: string;
  assigneeIds?: string[];
  /** Label IDs. Replaces the card's labels entirely. */
  labelIds?: string[];
  dueDate?: string;
  /** Custom-field writes, keyed by field ID. Each value carries its
   * type so the adapter doesn't have to re-introspect the schema.
   * Use `listCustomFields` to discover field IDs + valid types.
   * Setting a field to `null` clears it (where the backend supports
   * clearing); otherwise omit the key to leave the field as-is. */
  customFields?: Record<string, CustomFieldValue | null>;
}

/** Fields supplied to `createCard`. `title` is required; everything
 * else optional. `columnId` is the create-into column. */
export type CardCreate = CardPatch & { title: string };

// ===========================================================
// The WorkflowAdapter contract
// ===========================================================

/** The full WorkflowAdapter contract. An adapter is the set of
 * these functions for a single workflow-source kind. Each subpath
 * export (`@verevoir/workflows/trello`, etc.) re-exports a matching
 * set, plus an aggregate const that matches this shape. */
export interface WorkflowAdapter {
  /** Columns / workflow states on the board. Ordered by position
   * when the backend supports it; insertion order otherwise. */
  listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]>;

  /** Cards on the board, optionally filtered. */
  listCards(env: WorkflowEnv, boardUrl: string, filter?: CardFilter): Promise<Card[]>;

  /** A single card. Throws WorkflowApiError(status=404) when the
   * card doesn't exist. */
  getCard(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Card>;

  /** Cheap freshness check used by cache layers. Asks "is the
   * `version` handle the caller is holding still the live one for
   * this card?". The `version` is whatever the adapter put on
   * `Card.lastActivity` (Trello `dateLastActivity`, Notion
   * `last_edited_time`, etc.) from a prior `getCard` / `listCards`
   * read. Returns true when current; false when the card has moved
   * (including when it no longer exists).
   *
   * Adapters use the cheapest backend-native primitive: Trello
   * `?fields=dateLastActivity`, Notion `last_edited_time` on the
   * page object, etc. The cache layer in `@verevoir/context` gates
   * this behind a TTL so tight read loops don't hammer the upstream. */
  isCardFresh(
    env: WorkflowEnv,
    boardUrl: string,
    cardId: string,
    version: string
  ): Promise<boolean>;

  /** Create a new card in `columnId`. Returns the created card. */
  createCard(
    env: WorkflowEnv,
    boardUrl: string,
    columnId: string,
    fields: CardCreate
  ): Promise<Card>;

  /** Apply a patch to a card. Returns nothing — call getCard to
   * read back if you need the post-update state. */
  updateCard(env: WorkflowEnv, boardUrl: string, cardId: string, patch: CardPatch): Promise<void>;

  /** Move a card to a different column. Sugar for `updateCard`
   * with just `columnId`; exposed standalone because column-changes
   * are the central workflow operation and deserve discoverability. */
  moveCard(env: WorkflowEnv, boardUrl: string, cardId: string, toColumnId: string): Promise<void>;

  /** Comments on a card, most-recent-first. */
  listComments(env: WorkflowEnv, boardUrl: string, cardId: string): Promise<Comment[]>;

  /** Add a new comment to a card. */
  addComment(env: WorkflowEnv, boardUrl: string, cardId: string, body: string): Promise<void>;

  /** The custom fields available on this board — backend-defined
   * extension points beyond the standard Card properties. Returns
   * an empty array when the backend has no custom-field concept
   * (or the adapter doesn't support reading them yet). Consumers
   * cross-reference returned defs against `Card.customFields` keys
   * and `CardPatch.customFields` keys. */
  listCustomFields(env: WorkflowEnv, boardUrl: string): Promise<CustomFieldDef[]>;
}
