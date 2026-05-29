# Obsidian Kanban adapter for `@verevoir/workflows`

**Date:** 2026-05-29
**Status:** Proposed — pending review
**Module:** `@verevoir/workflows/obsidian` (new subpath)

## Summary

Add a new `WorkflowAdapter` implementation that maps the [Obsidian Kanban
plugin](https://github.com/obsidian-community/obsidian-kanban) markdown
format onto the existing neutral contract (`Column`, `Card`, `Label`,
`Comment`, `CustomFieldDef`). This makes a local Obsidian Kanban board a
first-class task-tracking backend alongside Trello and Notion — consumers
swap `boardUrl` and keep the same code.

Unlike Trello and Notion, an Obsidian Kanban board is **a single local
markdown file** — no API, no auth. A board file looks like:

```markdown
---
kanban-plugin: board
---

## To Do

- [ ] Wire pickAdapter into aigency-web #infra @{2026-06-02} ^vrw-a1b2c3
- [ ] Add tests for GH + FS dispatch ^vrw-d4e5f6

## In Progress

- [ ] Draft the adapter contract ^vrw-991abc

## Done

- [x] Spike the markdown round-trip ^vrw-77aa01


%% kanban:settings
{"kanban-plugin":"board","date-trigger":"@","date-format":"YYYY-MM-DD"}
%%
```

`## headings` are columns, `- [ ]` / `- [x]` items are cards, inline
`#tags` are labels, `@{…}` tokens are due dates, and the trailing
`%% kanban:settings %%` block holds board config as JSON.

## Goals

- Full read **and** write against a local board file.
- Map the format onto the contract with zero new runtime dependencies.
- Lossless round-trip: writes preserve everything the adapter doesn't
  manage (frontmatter, settings block, untouched cards' exact text).
- Give every card a **stable identity** that survives hand-edits and
  reordering, so `getCard`/`updateCard`/`moveCard` address cards
  reliably.

## Non-goals

- Wiring the adapter into the `@verevoir/mcp` server or any
  `pickAdapter` / source-router (separate repos).
- Reading a board file from anywhere other than the local filesystem
  (GitHub / `@verevoir/sources`-backed files) — designed for, not built.
- Custom-field support.
- Date formats beyond the plugin default (`@{YYYY-MM-DD}`) — best-effort
  for custom triggers/formats.

## Key design decisions

These were settled during brainstorming and drive the rest of the design:

1. **Board access — local path now, sources later.** `boardUrl` is an
   absolute path or `file://` URL to the board `.md`. A clean internal
   seam isolates file I/O so a GitHub/`@verevoir/sources`-backed variant
   can be added later without touching the contract.
2. **Card identity — injected Obsidian block IDs.** Each card gets a
   markdown block anchor (` ^vrw-<base36>`) appended to its first line.
   These are valid Obsidian block references, survive hand-edits and
   reordering, and serve as `Card.id`.
3. **Capabilities — full read + write**, with labels via `#tags`, due
   dates via the configurable `@{date}` token, and the "Done"/Complete
   lane treated as an ordinary column.

## Architecture

Approach chosen: **a hand-written, line-oriented parser into a typed
`Board` model with lossless round-trip.** Two alternatives were
considered and rejected:

- **Markdown AST library (remark/mdast):** more principled parsing, but
  the Kanban format has non-standard pieces (settings comment, date
  triggers, block anchors) requiring custom handling anyway, and it adds
  a heavy runtime dependency to a library that currently has none.
- **Regex / surgical line edits with no model:** minimal, but entangles
  parsing with contract logic and makes lossless writes and block-ID
  injection fragile.

The chosen approach mirrors how the Notion adapter separates
schema-detection from card-mapping, keeps the repo's near-zero-dependency
ethos, and isolates the gnarly parsing so it can be unit-tested in
isolation.

### Module layout

- **`src/obsidian/board-format.ts`** — the format layer. Owns the
  `Board` / `Lane` / `ObsidianCard` model, `parseBoard(text): Board`, and
  `serializeBoard(board): string`. Knows nothing about the
  `WorkflowAdapter` contract. Lossless: content the adapter doesn't
  manage re-emits unchanged.
- **`src/obsidian/index.ts`** — the adapter layer. Path parsing
  (`parseObsidianBoardPath`), file read/write (the seam), the contract
  method implementations, the aggregate `obsidian: WorkflowAdapter`
  export, and `envFromObsidianProcessEnv()`.
- **`tests/obsidian/board-format.test.ts`** — pure parser + round-trip
  tests against real board fixtures.
- **`tests/obsidian/obsidian.test.ts`** — adapter tests against temp
  files (`os.tmpdir()`), covering reads, writes, ID injection, and error
  cases.

### Packaging

- `package.json`: add the `./obsidian` export subpath (mirroring
  `./trello` and `./notion`).
- **No new runtime dependencies.** Uses only `node:fs`/`node:path`.
- Update `README.md` (Subpaths + a usage block), `llms.txt`, and
  `CHANGELOG.md`.

## The `Board` model

```ts
interface Board {
  /** Raw YAML frontmatter between the --- fences, verbatim. Includes
   *  the `kanban-plugin: board` marker. */
  frontmatter: string;
  lanes: Lane[];
  /** Raw `%% kanban:settings … %%` block, verbatim. Parsed lazily for
   *  date-trigger / date-format only when due dates are read/written. */
  settings: string;
  /** Trailing trivia (blank lines) preserved for round-trip fidelity. */
}

interface Lane {
  /** Heading text — also the Column id. */
  name: string;
  cards: ObsidianCard[];
}

interface ObsidianCard {
  /** Block-anchor id (the part after `^`), e.g. "vrw-a1b2c3".
   *  Undefined until minted. */
  id?: string;
  checked: boolean;          // - [x] vs - [ ]
  title: string;             // first line, minus anchor, tags, date tokens
  body: string;              // continuation lines, de-indented, verbatim
  tags: string[];            // inline #tags (without the #)
  due?: string;              // ISO date parsed from the @{…} token
  /** The card's original first line, verbatim. Re-emitted as-is when the
   *  card's structured fields are unchanged, preserving exact token
   *  order/positions. Rebuilt only when a managed field changes. */
  rawFirstLine: string;
}
```

## Contract mapping

| Contract concept | Obsidian Kanban representation |
|---|---|
| `Column` | `## Lane heading`. `id` = lane name (unique within a board), `position` = index. |
| `Card` | `- [ ]` item (or `- [x]` for checked). |
| `Card.id` | block anchor `^vrw-<base36>`, minted lazily (see below). |
| `Card.title` | first line text, minus the trailing anchor and minus the extracted tag/date tokens. |
| `Card.body` | continuation lines under the item, de-indented, verbatim markdown. Empty string when none. |
| `Card.columnId` / `columnName` | the containing lane's name. |
| `Card.labels` | inline `#tags`; tag text is both `id` and `name`, no color. |
| `Card.dueDate` | the plugin date token, default `@{YYYY-MM-DD}`; trigger/format read from the settings block. |
| `Card.lastActivity` | file mtime as ISO8601 (whole-file granularity — see freshness). |
| `Card.url` | omitted in v0 (no reliable vault-scoped Obsidian URL without the vault name). |
| `Card.parentId` | flat format. `listCards({parentId})` returns `[]`; setting `parentId` throws `WorkflowApiError(501)` (matches Trello/Notion). |
| `Card.assigneeIds` | no native concept. Read as `[]`; setting throws `501`. |
| Comments | no native concept. `listComments` returns `[]`; `addComment` throws `501`. |
| `customFields` | `listCustomFields` returns `[]`; custom-field writes ignored in v0. |

### Card-ID injection (the key behavior)

Block anchors are minted **lazily on any card-returning operation** —
`listCards`, `getCard`, and all writes. After parsing and mapping, if any
returned card lacked an anchor, the adapter appends ` ^vrw-<base36>` to
those cards' first lines and writes the file back **once**. If every card
already has an anchor, reads do **not** touch the file. `listColumns`
never writes.

This is the one documented read-side side effect, and it is what the
chosen identity strategy requires: a card must have an id before a
consumer can address it in a later `getCard`/`updateCard`/`moveCard`.

ID format: `vrw-` prefix + a short random base36 token, checked for
uniqueness within the board before assignment.

### Write safety — lossless round-trip

Every write follows read → mutate model → serialize → write:

- Cards the operation did **not** touch re-emit their `rawFirstLine`
  verbatim, preserving exact tag/date token positions and any inline
  formatting.
- Only a card whose `title`, `labels`, `dueDate`, `checked`, or column
  actually changed has its first line rebuilt, in the canonical order:
  `- [{x| }] {title} {#tags…} {@{date}} ^{id}`. Token order may
  normalize on these edited cards — an accepted trade-off.
- Frontmatter and the `%% kanban:settings %%` block are always preserved
  verbatim.
- `createCard` appends a new `- [ ]` item (with a freshly minted anchor)
  under the target lane.
- `moveCard` / a `columnId` change relocates the card block from its
  current lane to the target lane.

### Errors & freshness

- `WorkflowApiError(404)` — board file missing, or unknown card/lane id.
- `WorkflowApiError(501)` — unsupported writes: `parentId`, assignees,
  `addComment`.
- `isCardFresh(env, boardUrl, cardId, version)` compares the held
  `version` against the board file's current mtime (ISO8601). Coarse,
  whole-file granularity: any edit to the file invalidates all held
  versions. Documented as a known limitation.

### Auth / env

No credentials. `envFromObsidianProcessEnv()` returns `{ token: '' }` for
symmetry with the other adapters' env helpers; the adapter ignores
`env` entirely.

## Testing strategy

- **`board-format.test.ts`** — pure functions, no I/O:
  - parse → serialize round-trips on representative fixtures (with
    frontmatter, multiple lanes, checked/unchecked cards, tags, dates,
    multi-line bodies, existing anchors, and the settings block) are
    byte-stable for untouched content.
  - parsing edge cases: empty lanes, cards without anchors, cards with
    bodies, unusual but valid headings.
- **`obsidian.test.ts`** — adapter against temp board files:
  - `listColumns` / `listCards` / `getCard` mapping correctness.
  - lazy ID injection: a board with no anchors gains them after a read;
    a fully-anchored board is not rewritten by a read.
  - `createCard`, `updateCard`, `moveCard` mutate the file correctly and
    preserve untouched content.
  - error cases: missing file → 404, unknown id → 404, `parentId` /
    assignee / `addComment` → 501.
- CI already runs `lint` → `typecheck` → `test` → `build`; the new module
  and tests must pass all four.

## Risks & open questions

- **Reads mutate the file** (anchor injection). Surprising for a read,
  but required by the identity strategy and scoped to card-returning ops.
- **First-line normalization** on edited cards may reorder inline tokens
  relative to how a human wrote them. Untouched cards are unaffected.
- **Coarse freshness** (file mtime) means high cache-churn on busy
  boards. Acceptable for v0; a content-hash-per-card scheme could refine
  it later.
- **Custom date formats** beyond `@{YYYY-MM-DD}` are best-effort; exotic
  settings may not round-trip a written due date perfectly.
