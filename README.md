# @verevoir/workflows

Workflow-adapter primitive: one contract over kanban / issue / objective sources. Trello today; Jira, Linear, Notion databases, GitHub Issues/Projects, and an in-aigency wrapper over the objective tree follow under the same shape.

## Purpose

Surfaces workflow-shaped sources (cards with status, assignee, labels, custom fields) behind a single neutral contract — so consumers write code once and swap backends. Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources) (file-shape sources: GitHub, FS) and [`@verevoir/context`](https://github.com/verevoir/context) (the cache that fronts either kind).

The contract is intentionally non-flavoured by any one tool. `Column` is whatever the backend calls its workflow state (Trello list, Jira status, Notion select option, aigency objective phase). `Label` is whatever it calls its tags. Tools' extensions land in `customFields`.

## Most consumers reach this via MCP

If you're driving an LLM agent and want kanban / issue / objective operations as tools, you usually don't import `@verevoir/workflows` directly — you run the [`@verevoir/mcp`](https://github.com/verevoir/mcp) server, which wraps the Trello adapter (and future ones) as MCP tools: `list_columns` / `list_cards` / `get_card` / `create_card` / `update_card` / `move_card` / `list_comments` / `add_comment`. See [`@verevoir/mcp`](https://github.com/verevoir/mcp) for Claude Code config; key recommendation is `"alwaysLoad": true` so the tools surface as first-class instead of being deferred behind `ToolSearch`.

Direct in-process consumption (the usage shown below) is for: writing your own MCP server, embedding workflow operations in a non-MCP runtime, building higher-level libraries that compose multiple adapters, or implementing a new backend (Jira, Linear, Notion, custom).

## Subpaths

- `@verevoir/workflows` — two contracts. The original **card** contract (`WorkflowAdapter`, `Card`, `Column`, `Label`, `Comment`, `CardFilter`, `CardPatch`, `CardCreate`, `CustomFieldDef`, `CustomFieldValue`, `WorkflowEnv`, `WorkflowApiError`), and the **resource** contract that supersedes it (`ResourceAdapter`, `Resource`, `ResourceRef`, `ResourceTypeDescriptor`, `ResourceFilter`, `ResourcePatch`, `byRank`) together with the lifecycle operations described below — `claimResource` / `releaseClaim` (`ClaimingResourceAdapter`, `canClaim`) and `transitionResource` with its `TransitionPolicy`. Existing card adapters keep working; new work should target resources.
- `@verevoir/workflows/trello` — Trello adapter (read + write).
- `@verevoir/workflows/notion` — Notion-database adapter (read + write) via `@notionhq/client` (optional peer dep). Maps a Notion database to the WorkflowAdapter contract: rows are cards, the auto-detected status / select property provides columns, the people property gives assignees, the multi_select property gives labels. Body content round-trips through Notion's native `pages.retrieveMarkdown` / `pages.updateMarkdown`.
- `@verevoir/workflows/obsidian` — [Obsidian Kanban plugin](https://github.com/obsidian-community/obsidian-kanban) adapter (read + write) over a local board `.md` file. No credentials — `boardUrl` is an absolute path or `file://` URL. Lanes (`## headings`) are columns; cards are `- [ ] [[Note]]` wikilinks whose **linked note** is the source of truth: the note's frontmatter `id` is the card identity, its body is `Card.body`, its `tags` are labels, and a date field is the due date. Cards without a resolvable `id` are skipped on reads and 404 when addressed; the board file is never mutated to assign identity. File I/O goes through `@verevoir/sources` (the `fs` adapter for local boards), and frontmatter handling uses the `yaml` package — both are **optional peer dependencies** (like `@notionhq/client` for Notion), required only when you use this subpath.
- `@verevoir/workflows/backlog` — [Backlog.md](https://backlog.md) adapter (read + write) over a project's `backlog/` directory of markdown task files. No credentials — `boardUrl` is an absolute path (or `file://` URL) to the project root or the `backlog/` dir. Columns are the `statuses` from `backlog/config.yml` (default `To Do` / `In Progress` / `Done` when absent); each `backlog/tasks/*.md` is a card whose frontmatter carries `id` (identity, falling back to the filename stem), `title`, `status` (the column), `labels`, `assignee`, and `parent_task_id` (sub-tasks), with the markdown body as `Card.body`. `createCard` allocates the next `task-N` id; edits preserve unmanaged frontmatter (e.g. `created_date`). Same `@verevoir/sources` + `yaml` **optional peer dependencies** as the Obsidian subpath. Use it to plan and track work in a project repository as plain, committable files.

## Resources, and lifecycle operations that mean something

Tool budget is a hard limit. Eight tools spent on `card` leaves none for
`story`, `page`, `doc` or an objective tree — so everything addressable is a
**typed resource** instead, and the same handful of operations covers all of
them. A new type costs zero tools. Comments stop being a special case: a comment
is a resource with a `parentId`.

The trade is discoverability, and it is paid deliberately. `listCards` tells a
reader what it does; `listResources(type)` does not. So affordances move out of
names and into **data** — `listResourceTypes` reports which types exist, what
states each has, and what each supports:

```ts
[
  {
    type: 'task',
    states: ['To Do', 'In Progress', 'Done'],
    defaultState: 'To Do',
    claimableStates: ['To Do'],
    supports: ['create', 'update', 'transition', 'claim'],
  },
];
```

### State lives on the resource

`Resource.state` is a property of the resource — YAML frontmatter in a
file-backed source, a status property in Notion — and never a shared board
index. That is what makes a state change **one** write: two runners moving two
different resources touch different files and cannot collide, a change is a
one-line diff in that resource's own history, and a person can move an item by
editing one field in the GitHub web UI without racing anything.

The board is then a query, not a document, so it cannot go stale:

```ts
const ready = await adapter.listResources(env, sourceUrl, {
  type: 'task',
  state: 'To Do',
  unclaimed: true,
});
```

### `claimResource` — one operation, or it is a race

"List the ready ones, pick one, assign it, write it back" is four calls with
three gaps, and two runners racing through those gaps both see an unclaimed
resource and both believe they won. With state on the resource, claiming is a
single compare-and-swap on a single record — conditional on the revision that
was read.

Most backends cannot arbitrate at all, so `claimResource` / `releaseClaim` live
on a separate `ClaimingResourceAdapter` and are **absent** rather than emulated.
`canClaim(adapter)` asks. Do not fall back to read-then-write: that reinstates
the exact race while looking from outside as though it had been solved.

```ts
import { canClaim } from '@verevoir/workflows';

if (!canClaim(adapter)) throw new Error('this source cannot arbitrate claims');
const outcome = await adapter.claimResource(env, sourceUrl, {
  holder: 'runner-7',
  type: 'task', // omit `id` to take the first claimable one in rank order
});
```

Ordering is explicit. A board file made list _position_ the priority; a resource
model has nowhere to put that, so `Resource.rank` declares it and `byRank` sorts
— unranked resources last, so nothing unranked jumps the queue that ranking
exists to impose.

### `transitionResource` — a state you may only enter once its claim is true

A state names a claim about the world. "In preview" means deployed to preview;
"done" means live in production. Writing that claim without checking it is how a
board comes to assert things nothing verified.

`transitionResource` refuses until the state's declared entry conditions hold,
and leaves the resource untouched when it refuses. **What each state requires
differs per project**, so conditions are declared as data rather than written as
functions — a policy can then be read from project config, diffed in review, or
handed to a model, none of which a closure allows.

```ts
import { transitionResource, httpConditionChecker } from '@verevoir/workflows';

const policy = {
  states: [
    {
      state: 'in preview',
      requires: [
        {
          kind: 'http-ok',
          url: 'https://preview.example/health',
          describes: 'the preview environment answers',
        },
      ],
    },
    { state: 'done', requires: [{ kind: 'http-ok', url: 'https://app.example/health' }] },
  ],
};

const outcome = await transitionResource(
  adapter,
  env,
  sourceUrl,
  { type: 'task', id: 'task-004' },
  'in preview',
  { policy, check: httpConditionChecker, expectRevision: resource.revision }
);

if (outcome.outcome === 'refused') console.error(outcome.reason);
```

**`state` is not writable through `updateResource`.** It throws rather than
setting it, and points at `transitionResource` — so the guard is structural
rather than conventional, and cannot be walked around by reaching for the
primitive.

Three outcomes, deliberately distinct. `moved` succeeded. `refused` means a
condition did not hold — go and fix the world. `conflict` means every condition
held and the _write_ lost a race, so re-read and retry; calling that a refusal
would send a caller hunting for a failing check that does not exist.

The rule the guard rests on: **a condition that could not be evaluated refuses
the move.** Unreachable, timed out, no checker for the kind, a checker that
threw, no checker supplied at all — every one is `unknown`, and `unknown` is not
a pass. Failing open would leave the resource carrying the same unearned claim,
now with the appearance of having been verified, which is worse than no guard.
A state the policy does not mention is freely enterable.

`http-ok` ships, since "does the environment answer" is the check these states
want and it needs only `fetch`. It validates the scheme first: the policy is
project config, and a `file:` URL would have it read local disk on behalf of
whoever edited the policy and report that as evidence of a deployment. It also
reports an unreachable host as `unknown` rather than `failed` — a DNS blip and a
torn-down environment look identical from there, and only one of them means the
claim is false. `command` execution is left to the consumer, because running a
process grants whoever wrote the policy the ability to run it;
`firstCheckerToAnswer` chains your checker with the built-in one.

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

## Usage — Backlog.md

```ts
import { backlog } from '@verevoir/workflows/backlog';

// No credentials. Point at a repo that has a `backlog/` directory.
const env = { token: '' };
const boardUrl = '/path/to/repo'; // or '/path/to/repo/backlog'

const columns = await backlog.listColumns(env, boardUrl); // config.yml `statuses`
const cards = await backlog.listCards(env, boardUrl); // backlog/tasks/*.md

// Create a task — writes `backlog/tasks/task-N - <title>.md` with frontmatter.
const card = await backlog.createCard(env, boardUrl, 'To Do', {
  title: 'Draft the spec',
  body: '## Acceptance\n\n- [ ] outline\n',
  labelIds: ['planning'],
});

// Move it across statuses (rewrites the task file's `status` frontmatter).
await backlog.moveCard(env, boardUrl, card.id, 'In Progress');
```

Each `backlog/tasks/*.md` is a card: frontmatter carries `id`, `title`, `status` (the column), `labels`, `assignee`, and `parent_task_id`; the body is the description. Plan and track work as plain files committed alongside the code. Edits preserve unmanaged frontmatter; comments have no Backlog equivalent (read empty, reject writes with `WorkflowApiError(501)`).

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
