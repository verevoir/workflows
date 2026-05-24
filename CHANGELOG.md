# Changelog

## 0.1.1 — 2026-05-24

- **Trello Power-Up referer support.** Trello scopes Power-Up API keys to allowed-origin lists; server-side callers were 401-ing because `fetch` doesn't send a `Referer` header. `WorkflowEnv` gains an optional `referer?: string` field (adapters that don't need it ignore); the Trello adapter sets `Referer` from it. `envFromTrelloProcessEnv()` reads `TRELLO_REFERER` and populates the field. Required for any Trello deployment.
- New integration smoke (`tests/trello/integration.test.ts`) — read-only operations against a real Trello board, gated on `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER` + `TRELLO_TEST_BOARD_URL`. Skipped without all four, keeping CI green without credentials. Validates the adapter end-to-end against Trello's API.

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/workflows` — contract module: `WorkflowAdapter` interface + `Card` / `Column` / `Label` / `Comment` / `CardFilter` / `CardPatch` / `CardCreate` / `CustomFieldDef` / `CustomFieldValue` types + `WorkflowEnv` + `WorkflowApiError`. Designed to back kanban / issue / objective sources behind one neutral surface.
- `@verevoir/workflows/trello` — Trello adapter implementing the full contract. Read + write coverage: list columns + cards (filterable), get + create + update + move card, list + add comments. Auth via `"<apiKey>:<apiToken>"` packed into `WorkflowEnv.token`. `parentId` patches throw `WorkflowApiError(501)` (Trello is flat). `listCustomFields` returns `[]` at v0 — the Custom Fields Power-Up isn't wired yet.
- Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources) (file-shape) and [`@verevoir/context`](https://github.com/verevoir/context) (cache).
