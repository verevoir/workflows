# Changelog

## 0.4.0 — 2026-05-26

- **`CardFilter` gains `includeBody` + `limit`** for cheap list views. `includeBody` (default **true**, backward-compatible) set to `false` skips per-card body fetches — on Notion that's one `retrieveMarkdown` API call per row — and returns `Card.body === ''`; fetch a single body on demand with `getCard`. `limit` caps the number of cards returned (after filtering). Both honoured by the Notion and Trello adapters. Fixes large boards overflowing a consumer's result budget (STDIO-93).

## 0.3.1 — 2026-05-24

- **Fix: Notion `createCard` + `updateCard` body posts.** The adapter was calling `pages.updateMarkdown` with `replace_content: { markdown: body }`; Notion's API actually expects `replace_content: { new_str: body }`. 0.3.0 always failed body posting with `body.replace_content.new_str should be defined`. Now corrected (with `allow_deleting_content: true` so an empty body cleanly clears the page).
- Caught during the Trello → Notion work-tracker migration (Trello-39); every `createCard` with a body would 400. No tests caught it because the SDK mocks didn't validate the shape — adding that validation in tests is a follow-up worth doing.

## 0.3.0 — 2026-05-24

- **New: `@verevoir/workflows/notion`** — second WorkflowAdapter implementation, against a Notion database used as a kanban-shaped tracker. Auto-detects property mapping from the data source schema: `title` → row title, first `status`/`select` → column, first `people` → assignees, first `multi_select` → labels. Operations that depend on an unmapped property throw `WorkflowApiError(501)`.
- Uses Notion's v2026 database + data-source split (`c.databases.retrieve` → first `data_source`, then `c.dataSources.retrieve` + `c.dataSources.query`).
- Body content round-trips via Notion's native `pages.retrieveMarkdown` + `pages.updateMarkdown` — no in-house Markdown converter to maintain.
- `isCardFresh` via `last_edited_time` on a `pages.retrieve`.
- `envFromNotionProcessEnv()` builds a `WorkflowEnv` from `NOTION_API_KEY`.
- `@notionhq/client` is an optional peer dependency — consumers using only `/trello` don't pull it.
- **Contract: `Card.readableId?: string`** — optional human-readable identifier (Trello card number, Jira issue key, Notion `unique_id`, etc.). Distinct from `Card.id` (the stable record identifier the adapter uses for API calls); `readableId` is what humans paste into commits, branches, PR titles.
- Trello adapter populates `readableId` from `idShort` (Trello's auto-incrementing card number).
- Notion adapter reads `readableId` from a configured property (defaults to one named `ID`; override via `NOTION_READABLE_ID_PROPERTY` env var). Supports `unique_id` (renders as `<prefix>-<number>` when prefixed, e.g. `STDIO-42`), `rich_text`, `formula.string`, and `title` shapes.
- Notion ID parser loosened per Adam's "use as-is if not just a number" rule: URL extraction + bare-32-hex dashifying retained for canonical form; other non-numeric input passes through (the SDK rejects bad IDs at call time).
- 32 new tests (50→62 total + 6 skipped) covering everything above.

## 0.2.1 — 2026-05-24

- Docs: README gains a "Most consumers reach this via MCP" section pointing at `@verevoir/mcp` and the `alwaysLoad: true` Claude Code config. Calls out that the MCP server exposes the Trello adapter as MCP tools, so most LLM-driven consumers don't need to import this package directly.
- **New: `llms.txt`** — was missing; this release ships one alongside `README.md` for LLM-shaped documentation discovery. Same shape as the sibling packages.
- Adds `llms.txt` to `package.json`'s `files` array so it ships in the npm tarball.

## 0.2.0 — 2026-05-24

- **Contract: `isCardFresh(env, boardUrl, cardId, version)`** added to `WorkflowAdapter`. Cache layers ask the workflow source whether a held `version` (the `lastActivity` timestamp from a prior `getCard` / `listCards`) is still current. Returns `true` when current, `false` when moved (including 404 / card removed). Pairs with the `wrapWithCache` validation TTL in `@verevoir/context`.
- `@verevoir/workflows/trello`: implements `isCardFresh` as a single GET with `?fields=dateLastActivity` — the cheapest probe Trello offers. 404 maps to false.
- **Breaking for third-party adapters** (none today): the new method is required on the interface.

## 0.1.1 — 2026-05-24

- **Trello Power-Up referer support.** Trello scopes Power-Up API keys to allowed-origin lists; server-side callers were 401-ing because `fetch` doesn't send a `Referer` header. `WorkflowEnv` gains an optional `referer?: string` field (adapters that don't need it ignore); the Trello adapter sets `Referer` from it. `envFromTrelloProcessEnv()` reads `TRELLO_REFERER` and populates the field. Required for any Trello deployment.
- New integration smoke (`tests/trello/integration.test.ts`) — read-only operations against a real Trello board, gated on `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER` + `TRELLO_TEST_BOARD_URL`. Skipped without all four, keeping CI green without credentials. Validates the adapter end-to-end against Trello's API.

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/workflows` — contract module: `WorkflowAdapter` interface + `Card` / `Column` / `Label` / `Comment` / `CardFilter` / `CardPatch` / `CardCreate` / `CustomFieldDef` / `CustomFieldValue` types + `WorkflowEnv` + `WorkflowApiError`. Designed to back kanban / issue / objective sources behind one neutral surface.
- `@verevoir/workflows/trello` — Trello adapter implementing the full contract. Read + write coverage: list columns + cards (filterable), get + create + update + move card, list + add comments. Auth via `"<apiKey>:<apiToken>"` packed into `WorkflowEnv.token`. `parentId` patches throw `WorkflowApiError(501)` (Trello is flat). `listCustomFields` returns `[]` at v0 — the Custom Fields Power-Up isn't wired yet.
- Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources) (file-shape) and [`@verevoir/context`](https://github.com/verevoir/context) (cache).
