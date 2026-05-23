# Changelog

## 0.1.0 — 2026-05-23

Initial release.

- `@verevoir/workflows` — contract module: `WorkflowAdapter` interface + `Card` / `Column` / `Label` / `Comment` / `CardFilter` / `CardPatch` / `CardCreate` / `CustomFieldDef` / `CustomFieldValue` types + `WorkflowEnv` + `WorkflowApiError`. Designed to back kanban / issue / objective sources behind one neutral surface.
- `@verevoir/workflows/trello` — Trello adapter implementing the full contract. Read + write coverage: list columns + cards (filterable), get + create + update + move card, list + add comments. Auth via `"<apiKey>:<apiToken>"` packed into `WorkflowEnv.token`. `parentId` patches throw `WorkflowApiError(501)` (Trello is flat). `listCustomFields` returns `[]` at v0 — the Custom Fields Power-Up isn't wired yet.
- Sibling to [`@verevoir/sources`](https://github.com/verevoir/sources) (file-shape) and [`@verevoir/context`](https://github.com/verevoir/context) (cache).
