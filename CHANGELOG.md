# Changelog

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
