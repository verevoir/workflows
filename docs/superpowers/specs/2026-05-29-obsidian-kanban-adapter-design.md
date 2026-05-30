# Obsidian Kanban adapter for `@verevoir/workflows`

**Date:** 2026-05-29
**Status:** Proposed — pending review
**Module:** `@verevoir/workflows/obsidian` (new subpath)

## Summary

Add a new `WorkflowAdapter` implementation that maps the [Obsidian Kanban
plugin](https://github.com/obsidian-community/obsidian-kanban) onto the
existing neutral contract (`Column`, `Card`, `Label`, `Comment`,
`CustomFieldDef`). This makes a local Obsidian Kanban board a first-class
task-tracking backend alongside Trello and Notion — consumers swap
`boardUrl` and keep the same code.

Unlike Trello and Notion, an Obsidian Kanban board is **a local markdown
file** — no API, no auth. Crucially, cards are **linked notes**: each card
is a wikilink to a separate `.md` note, and that note (its frontmatter and
body) is the source of truth for the card's identity and content. The
board file only records which lane a card sits in and in what order.

A board file looks like:

```markdown
---
kanban-plugin: board
---

## To Do

- [ ] [[Draft the onboarding flow]]
- [ ] [[Add tests for the parser]]

## In Progress

- [ ] [[Draft the adapter contract]]

## Done

- [x] [[Spike the markdown round-trip]]

%% kanban:settings
{"kanban-plugin":"board"}
%%
```

…and a linked card note (`Draft the onboarding flow.md`) looks
like:

```markdown
---
id: PROJ-141
title: Draft the onboarding flow
tags: [infra, adapter]
due: 2026-06-02
---

Sketch the first-run experience and where each step routes.

## Acceptance

- Flow documented in /docs/onboarding.md
- Tests cover each step
```

`## headings` are columns, `- [ ] [[Note]]` items are cards, and each
card's identity/content come from the linked note.

## Goals

- Full read **and** write against a local board + its linked card notes.
- Stable card identity from a **frontmatter `id` field** on the linked
  note — never by mutating the board file.
- Lossless round-trip: writes preserve everything the adapter doesn't
  manage (board frontmatter, settings block, untouched lanes/cards,
  unmanaged note frontmatter keys, note body when only metadata changes).
- Map cleanly onto the contract, reusing the conventions of the existing
  adapters.

## Non-goals

- Wiring the adapter into an MCP server or a board-source router
  (separate repos).
- A non-filesystem `@verevoir/sources` backend (e.g. a GitHub-hosted
  vault). The adapter already runs on a `SourceAdapter`, so this is a
  configuration change rather than a rewrite — but only the `fs`
  adapter is wired in here.
- Board-level custom-field schema (`listCustomFields` returns `[]` in v0).
- Assignees and comments — no native Obsidian concept; stubbed (read
  empty, write `501`). Revisitable via note frontmatter later.

## Key design decisions

These were settled during brainstorming and drive the rest of the design:

1. **Board access — through a `@verevoir/sources` SourceAdapter.** All
   file I/O (board, notes, vault scan, writes) goes through a
   `SourceAdapter`, not `node:fs` directly — per ADR 019 (Source Adapters
   as Foundation Libraries) and ADR 017 (no direct local clones). The `fs`
   adapter is wired in for local boards (`boardUrl` is an absolute path or
   `file://` URL); a GitHub/object-store-backed vault is then a swap of
   the adapter instance, not a rewrite. The adapter operates in the
   SourceAdapter's `(root, relative-path)` space.
2. **Card identity — linked-note frontmatter `id`.** A card is a wikilink
   to a note; that note's `id` frontmatter field is `Card.id`. The
   adapter never mints anchors or otherwise mutates the board to create
   identity. Field name defaults to `id`, overridable via
   `OBSIDIAN_ID_FIELD`.
3. **Source of truth — the linked note.** id, title, body, labels, and
   due date come from the note's frontmatter/body. The board file
   contributes only column placement and ordering.
4. **No-id cards are skipped on reads, error when addressed.** Plain-text
   cards, unresolvable wikilinks, and linked notes missing the `id` field
   are omitted from `listCards`. `getCard`/`updateCard`/`moveCard` on such
   a card throws `WorkflowApiError(404)`.
5. **Wikilink resolution — relative first, vault root fallback.** A
   `[[Name]]` resolves against the board file's folder (and the configured
   card folder) first; if unresolved and `OBSIDIAN_VAULT_PATH` is set, the
   vault is scanned vault-wide (shortest-path tiebreak), as Obsidian does.
6. **Title writes — frontmatter `title`, never rename.** `title` reads as
   frontmatter `title` ?? note filename. Writing a title sets the
   frontmatter `title` field and never renames the file, so the board
   wikilink and any backlinks elsewhere never break.
7. **`yaml` for frontmatter, as an optional peer dependency.** Note and
   board frontmatter are parsed and edited with the `yaml` package
   (comment/CST-preserving) rather than a hand-rolled parser, for
   robustness against arbitrary frontmatter. `yaml` and `@verevoir/sources`
   are **optional peer dependencies** (mirroring the Notion adapter's
   `@notionhq/client`), so Trello-/Notion-only consumers don't pull them.
8. **Freshness — composite content sha.** `Card.lastActivity` is
   `"<noteSha>|<boardSha>"`, the SourceAdapter's content shas for the note
   and board files. The note component catches body/frontmatter edits; the
   board component catches column moves/reordering. An opaque change handle
   (per the contract), not a wall-clock timestamp — and content-based, so
   it can't be fooled by mtime quirks.

## Architecture

The format layer is split from the adapter layer, mirroring how the Notion
adapter separates schema-detection from card-mapping. The board file is
parsed by a hand-written, line-oriented parser into a typed `Board` model
(lossless round-trip); note frontmatter goes through `yaml`.

Rejected alternatives for board parsing: a full markdown AST library
(remark/mdast) — heavy dependency for a format with non-standard pieces
(settings comment, wikilink cards) needing custom handling anyway; and
regex/surgical edits with no model — entangles parsing with contract logic
and makes lossless writes fragile.

### Module layout

- **`src/obsidian/board-format.ts`** — the board-file format layer. Owns
  the `Board` / `Lane` / `BoardCard` model, `parseBoard(text): Board`, and
  `serializeBoard(board): string`. Knows nothing about the contract.
  Lossless: lanes/cards the adapter doesn't touch re-emit verbatim.
- **`src/obsidian/wikilink.ts`** — parse `[[target|alias]]` board lines and
  resolve a target to a note path (relative-first, then a tree-wide
  fallback via the SourceAdapter's `getRepoTree`, skipping dot-folders).
  Takes a `SourceAdapter` + root; holds no `node:fs`.
- **`src/obsidian/note.ts`** — read/write a card note: split frontmatter
  (via `yaml`) from body, read managed fields, and apply edits while
  preserving unmanaged frontmatter keys and the body.
- **`src/obsidian/index.ts`** — the adapter layer: path parsing
  (`parseObsidianBoardPath`), config from env, the `layout()` seam that
  maps a `boardUrl` onto SourceAdapter `(root, relative-path)` coordinates,
  all I/O via `@verevoir/sources/fs`, contract method implementations, the
  aggregate `obsidian: WorkflowAdapter` export, and
  `envFromObsidianProcessEnv()`.
- **`tests/obsidian/board-format.test.ts`** — pure parse + round-trip.
- **`tests/obsidian/wikilink.test.ts`** — wikilink parse + resolution.
- **`tests/obsidian/note.test.ts`** — note frontmatter read/edit fidelity.
- **`tests/obsidian/obsidian.test.ts`** — adapter over a temp vault.

### Packaging

- `package.json`: add the `./obsidian` export subpath (mirroring
  `./trello` and `./notion`), and add **`yaml`** and **`@verevoir/sources`**
  as **optional peer dependencies** (mirroring `@notionhq/client`), with
  dev-dependency entries for the build/test gate.
- Update `README.md` (Subpaths + a usage block), `llms.txt`, and
  `CHANGELOG.md`.

## Configuration

No credentials. `envFromObsidianProcessEnv()` returns `{ token: '' }` for
symmetry; the adapter ignores `env`. Optional behavior is read from
`process.env` at call time (the pattern the Notion adapter uses for
`NOTION_READABLE_ID_PROPERTY`):

| Env var                | Default        | Purpose                                                                                         |
| ---------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `OBSIDIAN_VAULT_PATH`  | _(unset)_      | Vault root for wikilink fallback resolution. When unset, only relative resolution is attempted. |
| `OBSIDIAN_ID_FIELD`    | `id`           | Note frontmatter field holding the card identity (also surfaced as `readableId`).               |
| `OBSIDIAN_CARD_FOLDER` | board's folder | Where `createCard` writes new note files.                                                       |
| `OBSIDIAN_DATE_FIELD`  | `due`          | Note frontmatter field for `Card.dueDate`.                                                      |
| `OBSIDIAN_TAGS_FIELD`  | `tags`         | Note frontmatter field for `Card.labels`.                                                       |

## The `Board` model

```ts
interface Board {
  /** Raw YAML frontmatter between the --- fences, verbatim. */
  frontmatter: string;
  lanes: Lane[];
  /** Raw `%% kanban:settings … %%` block, verbatim. */
  settings: string;
}

interface Lane {
  /** Heading text — also the Column id. */
  name: string;
  cards: BoardCard[];
}

interface BoardCard {
  /** Full board line, verbatim — re-emitted as-is unless this card is
   *  moved/created, preserving checkbox state and any trailing text. */
  rawLine: string;
  checked: boolean; // - [x] vs - [ ]
  /** Parsed wikilink target/alias, or undefined for a plain-text card. */
  link?: { target: string; alias?: string };
}
```

A contract `Card` is assembled by combining a `BoardCard`'s lane placement
with its resolved linked note.

## Contract mapping

| Contract concept               | Obsidian representation                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `Column`                       | `## Lane heading`. `id` = lane name (unique within a board), `position` = index.                              |
| `Card`                         | a `- [ ] [[Note]]` board item whose note resolves and carries an `id`.                                        |
| `Card.id`                      | linked-note frontmatter `id` (field name per `OBSIDIAN_ID_FIELD`).                                            |
| `Card.readableId`              | same value as `id` (it is the human-facing identifier authors paste into commits/branches).                   |
| `Card.title`                   | note frontmatter `title` ?? note filename (without `.md`).                                                    |
| `Card.body`                    | the note's markdown body (after its frontmatter), verbatim.                                                   |
| `Card.columnId` / `columnName` | the containing lane's name.                                                                                   |
| `Card.labels`                  | note frontmatter `tags` (field per `OBSIDIAN_TAGS_FIELD`); each tag string is both `id` and `name`, no color. |
| `Card.dueDate`                 | note frontmatter `due` (field per `OBSIDIAN_DATE_FIELD`), as ISO8601.                                         |
| `Card.url`                     | `file://` URL to the linked note file.                                                                        |
| `Card.lastActivity`            | composite version `"<noteSha>                                                                                 | <boardSha>"` (see freshness). |
| `Card.parentId`                | flat. `listCards({parentId})` returns `[]`; setting `parentId` throws `WorkflowApiError(501)`.                |
| `Card.assigneeIds`             | no native concept. Read `[]`; setting throws `501`.                                                           |
| Comments                       | no native concept. `listComments` `[]`; `addComment` throws `501`.                                            |
| `customFields`                 | `listCustomFields` returns `[]`; per-card custom fields not surfaced in v0.                                   |

### Finding a card by id

`getCard`/`updateCard`/`moveCard` take a `cardId`. The adapter parses the
board and walks each lane's link cards, resolving notes and matching the
frontmatter `id`, **short-circuiting on the first match**. Not found
(including plain-text or id-less cards) → `WorkflowApiError(404)`. This is
O(cards) note reads in the worst case (id absent); a cross-call id→path
index is the later refinement. With the SourceAdapter seam this would live
in `@verevoir/context` rather than being hand-rolled here.

### Read behavior — no file mutation

`listCards` resolves every link card; cards whose note is unresolvable or
lacks an `id` are silently omitted. Reads never write to the board or to
note files. `listColumns` reads only the board file.

### Write behavior — lossless

- **`createCard`** mints a new `id` (UUID) into a new note file written to
  `OBSIDIAN_CARD_FOLDER` (default: the board's folder), with `title`,
  body, `tags`, and `due` from the `CardCreate`. The filename is derived
  from the title (sanitized, deduped against existing files). A
  `- [ ] [[<note name>]]` line is appended to the target lane. Returns the
  assembled `Card`.
- **`updateCard`** edits the linked note: `title`/`tags`/`due` rewrite
  those frontmatter keys (preserving all other keys and the body);
  `body` rewrites the note body (preserving frontmatter). A `columnId`
  change moves the board link line to the target lane. The note file is
  never renamed.
- **`moveCard`** relocates the link line for the card with that `id`
  between lanes in the board file. The note is untouched.
- Board frontmatter, the `%% kanban:settings %%` block, and every lane and
  card the operation didn't touch are preserved verbatim.

### Errors & freshness

- `WorkflowApiError(404)` — board file missing, or no card with the given
  `id` (covers plain-text / unresolvable / id-less cards).
- `WorkflowApiError(501)` — unsupported writes: `parentId`, assignees,
  `addComment`.
- `isCardFresh(env, boardUrl, cardId, version)` parses `version` as
  `"<noteSha>|<boardSha>"` and compares both components against the
  SourceAdapter's current note-file and board-file content shas. The note
  component catches content edits; the board component catches column
  moves/reordering. Content-based rather than mtime-based, so it can't be
  fooled by clock granularity; any board edit invalidates all held
  versions (the board sha shifts) — accepted for v0 and documented.

## Testing strategy

- **`board-format.test.ts`** — parse → serialize round-trips are byte-
  stable for untouched content (frontmatter, multiple lanes, checked/
  unchecked link cards, plain-text cards, the settings block); parsing
  edge cases (empty lanes, aliased/pathed wikilinks, plain-text items).
- **`wikilink.test.ts`** — parse `[[Name]]`, `[[Name|Alias]]`,
  `[[folder/Name]]`; resolution: relative hit, configured-folder hit,
  vault-root fallback (shortest-path tiebreak), and unresolved → omitted.
- **`note.test.ts`** — read managed fields; edit title/tags/due/body while
  preserving unmanaged frontmatter keys and untouched sections.
- **`obsidian.test.ts`** — adapter over a temp vault: `listColumns`,
  `listCards` (with id-less/plain cards skipped), `getCard`,
  `createCard` (note file + board link written), `updateCard` (frontmatter
  - body + column move), `moveCard`; error cases — missing file → 404,
    unknown/ id-less id → 404, `parentId`/assignee/`addComment` → 501.
- CI runs `lint` → `typecheck` → `test` → `build`; all must pass.

## Risks & open questions

- **Find-by-id cost.** Addressing a card resolves notes across the board
  until the id matches (short-circuiting on the match) — O(cards) reads in
  the worst case. Fine for typical boards; a cross-call id→path index in
  `@verevoir/context` is the refinement.
- **Coarse freshness.** The board-file sha in the composite version churns
  all cards' freshness on any board edit. Safe (over-invalidates), never
  unsafe.
- **Wikilink resolution ambiguity.** Without `OBSIDIAN_VAULT_PATH`, only
  relative resolution runs; vault-wide shortest-path resolution requires
  the configured vault root and a `getRepoTree` scan.
- **Vault-scan cap.** The tree-wide fallback uses the SourceAdapter's
  `getRepoTree`, which caps at the adapter's tree limit (5000 entries for
  `fs`) and skips its ignored dirs. A vault larger than the cap could miss
  a deep note in fallback resolution — acceptable for v0.
- **Mixed boards.** Boards mixing plain-text and linked-note cards work,
  but the plain-text cards are invisible to consumers (skipped). This is
  intentional per decision 4; worth calling out to users.
- **`yaml` + `@verevoir/sources` peer deps.** Both are optional peer
  dependencies; a consumer using the Obsidian subpath must have them
  installed (as a Notion consumer must have `@notionhq/client`). Trello-
  and Notion-only consumers pull neither.

## Design history

An earlier draft gave cards identity by **injecting Obsidian block anchors**
(` ^vrw-…`) into the board file, with the board line as the source of truth
and lazy anchor-minting on reads. That was superseded by the linked-note
model above: identity comes from existing note frontmatter, the adapter
never mutates the board to create identity, and cards without a stable id
are skipped rather than assigned one.
