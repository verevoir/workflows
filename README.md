# @verevoir/workflows

Workflow-adapter primitive: one contract over kanban / issue / objective sources. Trello today; Jira, Linear, Notion databases, GitHub Issues/Projects, and an in-aigency wrapper over the objective tree follow under the same shape.

## Purpose

Surfaces workflow-shaped sources (cards with status, assignee, labels, custom fields) behind a single neutral contract — so consumers write code once and swap backends. Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources) (file-shape sources: GitHub, FS) and [`@verevoir/context`](https://github.com/verevoir/context) (the cache that fronts either kind).

The contract is intentionally non-flavoured by any one tool. `Column` is whatever the backend calls its workflow state (Trello list, Jira status, Notion select option, aigency objective phase). `Label` is whatever it calls its tags. Tools' extensions land in `customFields`.

## Most consumers reach this via MCP

If you're driving an LLM agent and want kanban / issue / objective operations as tools, you usually don't import `@verevoir/workflows` directly — you run the [`@verevoir/mcp`](https://github.com/verevoir/mcp) server, which wraps the Trello adapter (and future ones) as MCP tools: `list_columns` / `list_cards` / `get_card` / `create_card` / `update_card` / `move_card` / `list_comments` / `add_comment`. See [`@verevoir/mcp`](https://github.com/verevoir/mcp) for Claude Code config; key recommendation is `"alwaysLoad": true` so the tools surface as first-class instead of being deferred behind `ToolSearch`.

Direct in-process consumption (the usage shown below) is for: writing your own MCP server, embedding workflow operations in a non-MCP runtime, building higher-level libraries that compose multiple adapters, or implementing a new backend (Jira, Linear, Notion, custom).

## Subpaths

- `@verevoir/workflows` — contract module: `WorkflowAdapter`, `Card`, `Column`, `Label`, `Comment`, `CardFilter`, `CardPatch`, `CardCreate`, `CustomFieldDef`, `CustomFieldValue`, `WorkflowEnv`, `WorkflowApiError`.
- `@verevoir/workflows/trello` — Trello adapter (read + write).
- `@verevoir/workflows/notion` — Notion-database adapter (read + write) via `@notionhq/client` (optional peer dep). Maps a Notion database to the WorkflowAdapter contract: rows are cards, the auto-detected status / select property provides columns, the people property gives assignees, the multi_select property gives labels. Body content round-trips through Notion's native `pages.retrieveMarkdown` / `pages.updateMarkdown`.
- `@verevoir/workflows/obsidian` — [Obsidian Kanban plugin](https://github.com/obsidian-community/obsidian-kanban) adapter (read + write) over a local board `.md` file. No credentials — `boardUrl` is an absolute path or `file://` URL. Lanes (`## headings`) are columns; cards are `- [ ] [[Note]]` wikilinks whose **linked note** is the source of truth: the note's frontmatter `id` is the card identity, its body is `Card.body`, its `tags` are labels, and a date field is the due date. Cards without a resolvable `id` are skipped on reads and 404 when addressed; the board file is never mutated to assign identity. File I/O goes through `@verevoir/sources` (the `fs` adapter for local boards), and frontmatter handling uses the `yaml` package — both are **optional peer dependencies** (like `@notionhq/client` for Notion), required only when you use this subpath.

## Install

```bash
npm install @verevoir/workflows
```

No required peer dependencies.

## Canonical usage — Trello

```ts
import { envFromTrelloProcessEnv, trello } from '@verevoir/workflows/trello';

// Set TRELLO_API_KEY + TRELLO_API_TOKEN in your environment.
const env = envFromTrelloProcessEnv();
if (!env) throw new Error('TRELLO_API_KEY or TRELLO_API_TOKEN not set');

const boardUrl = 'https://trello.com/b/abc123/my-board';

// Read what's on the board.
const columns = await trello.listColumns(env, boardUrl);
const cards = await trello.listCards(env, boardUrl, { columnId: columns[0].id });

// Move a card across columns.
await trello.moveCard(env, boardUrl, cards[0].id, columns[1].id);

// Add a comment.
await trello.addComment(env, boardUrl, cards[0].id, 'Picked this up, starting now.');

// Create a new card.
const fresh = await trello.createCard(env, boardUrl, columns[0].id, {
  title: 'Wire pickAdapter into aigency-web',
  body: '## Acceptance\n\n- Factory at /lib/source-router.ts\n- Tests cover GH + FS dispatch\n',
  labelIds: [],
});
```

## Usage — Obsidian Kanban

```ts
import { obsidian } from '@verevoir/workflows/obsidian';

// No credentials. Point at a local Obsidian Kanban board file.
// Set OBSIDIAN_VAULT_PATH so vault-wide `[[wikilink]]` resolution works.
const env = { token: '' };
const boardUrl = '/path/to/Vault/Board/My-Board.md';

const columns = await obsidian.listColumns(env, boardUrl); // lanes
const cards = await obsidian.listCards(env, boardUrl); // linked notes with an `id`

// Create a card — writes a new note (with a minted `id`) and links it.
const card = await obsidian.createCard(env, boardUrl, columns[0].id, {
  title: 'Draft the spec',
  body: '# Draft the spec\n\n- [ ] outline\n',
  labelIds: ['planning'],
});

// Move it across lanes (rewrites only the board file's link line).
await obsidian.moveCard(env, boardUrl, card.id, columns[1].id);
```

Cards are Obsidian Kanban **linked notes**: each `- [ ] [[Note]]` item resolves to a note whose frontmatter `id` is the card identity and whose body/tags supply the card content. Cards that are plain text or lack a resolvable `id` are skipped on reads. The board file is never mutated to assign identity. Assignees and comments have no Obsidian equivalent — they read empty and reject writes with `WorkflowApiError(501)`.

## The contract

```ts
interface WorkflowAdapter {
  listColumns(env, boardUrl): Promise<Column[]>;
  listCards(env, boardUrl, filter?): Promise<Card[]>;
  getCard(env, boardUrl, cardId): Promise<Card>;
  isCardFresh(env, boardUrl, cardId, version): Promise<boolean>;
  createCard(env, boardUrl, columnId, fields): Promise<Card>;
  updateCard(env, boardUrl, cardId, patch): Promise<void>;
  moveCard(env, boardUrl, cardId, toColumnId): Promise<void>;
  listComments(env, boardUrl, cardId): Promise<Comment[]>;
  addComment(env, boardUrl, cardId, body): Promise<void>;
  listCustomFields(env, boardUrl): Promise<CustomFieldDef[]>;
}
```

`isCardFresh` answers "is the `version` I'm holding (the `lastActivity` timestamp from a prior `getCard` / `listCards`) still the live one?" — the cheap freshness check cache layers (`@verevoir/context`'s `wrapWithCache`) use to validate held cards without re-fetching. Returns `false` when the card has moved (including 404 / removed).

`Card` carries the universal-ish properties (`title`, `body`, `columnId`, `parentId?`, `assigneeIds`, `labels`, `dueDate?`, `url?`, `lastActivity?`, `readableId?`) plus an open `customFields?` bag keyed by field ID. Backend-specific fields (Jira story points, Notion select properties, etc.) land there with typed values.

`readableId` is the human-readable identifier when the backend has one: Trello card number, Jira issue key, Linear identifier, Notion's `ID` property when configured. Distinct from `id` (the stable record identifier the adapter uses for API calls) — `readableId` is what humans paste into commits, branches, PR titles.

For the Notion adapter specifically, `readableId` reads from the property named `ID` by default; override with the `NOTION_READABLE_ID_PROPERTY` env var. Supports `unique_id` (renders as `<prefix>-<number>` — e.g. `STDIO-42`), `rich_text`, `formula.string`, and `title` property types.

## Authentication

Each adapter packs its auth shape into `WorkflowEnv.token`:

- **Trello** — `"<apiKey>:<apiToken>"` (split on first `:`).
- **Obsidian** — none; the adapter reads local files only. `envFromObsidianProcessEnv()` returns `{ token: '' }`.
- **Jira** (future) — `"<email>:<api-token>"` (basic auth).
- **Notion** (future) — `"<integration-token>"` (single value).
- **Linear** (future) — `"<api-key>"` (single value).

Per-adapter `envFromXxxProcessEnv()` helpers build a valid env from process environment variables.

## Hierarchy support

Cards carry an optional `parentId` for hierarchical workflows (Jira sub-tasks under epics, Notion nested rows, aigency sub-objectives). Trello is flat — its adapter throws `WorkflowApiError(501)` if a patch tries to set `parentId`, rather than silently ignoring.

## Custom fields

Workflow tools that expose backend-defined custom fields (Jira's story points / sprint / severity, Notion DB properties, Linear estimates) populate them via the `customFields` map on `Card`, and accept writes via the `customFields` map on `CardPatch`. The schema is discoverable via `listCustomFields(env, boardUrl)` — consumers cross-reference returned field IDs against the values on each card.

Adapters that don't support custom fields (Trello v0) return `[]` from `listCustomFields` and leave `Card.customFields` undefined.

## What this is NOT

- Not a caching layer. Cache the responses via [`@verevoir/context`](https://github.com/verevoir/context) (a Trello-specific subpath there is a future addition).
- Not a sync engine. Adapters are stateless clients; cross-backend mirroring (e.g., aigency objectives ↔ a customer Jira) belongs in a separate sync layer.
- Not opinionated about scope. `boardUrl` is opaque to the contract; per-adapter URL parsing defines what it means.

## See also

- [`@verevoir/sources`](https://github.com/verevoir/sources) — file-shape sources (GitHub, FS).
- [`@verevoir/context`](https://github.com/verevoir/context) — in-process cache for content + symbols. Fronts file sources today; will front workflow sources when read patterns warrant.
- [`@verevoir/llm`](https://github.com/verevoir/llm) — provider-agnostic LLM call surface.

## Credits

The Obsidian Kanban adapter (`@verevoir/workflows/obsidian`) was contributed by **Kevin Ashton**.

## License

Apache-2.0.
