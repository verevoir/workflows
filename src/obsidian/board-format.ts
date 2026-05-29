// @verevoir/workflows/obsidian — board-file format layer
//
// Parses an Obsidian Kanban board markdown file into a typed model and
// serializes it back. The board file records lanes (## headings) and
// the cards in each (- [ ] / - [x] list items, usually a [[wikilink]]
// to a card note). The frontmatter block and the trailing
// `%% kanban:settings %%` block are preserved verbatim — the adapter
// only manages lanes and cards.
//
// Serialization is canonical (heading, blank line, one card per line,
// blank line between lanes). The Obsidian Kanban plugin itself rewrites
// the file in canonical form whenever it saves, so normalizing
// inter-lane whitespace does not fight the plugin. parse → serialize is
// idempotent.

import { parseWikilink, type ParsedWikilink } from './wikilink.js';

export interface BoardCard {
  /** The card's board line, verbatim (e.g. "- [ ] [[Test Card]]"). */
  rawLine: string;
  checked: boolean;
  /** Parsed wikilink, or undefined for a plain-text card. */
  link?: ParsedWikilink;
}

export interface Lane {
  /** Heading text — also the Column id. */
  name: string;
  cards: BoardCard[];
}

export interface Board {
  /** Raw leading frontmatter region (everything before the first lane
   * heading), verbatim. Empty string when the file has none. */
  frontmatter: string;
  lanes: Lane[];
  /** Raw trailing `%% kanban:settings … %%` region, verbatim. Empty
   * string when absent. */
  settings: string;
}

const LANE_HEADING = /^##\s+(.*)$/;
const CARD_LINE = /^-\s+\[([ xX])\]\s?(.*)$/;
const SETTINGS_START = '%% kanban:settings';

/** Parses a board markdown file into the Board model. */
export function parseBoard(text: string): Board {
  const lines = text.split('\n');

  // Locate the settings region (from the %% kanban:settings marker to EOF).
  const settingsIdx = lines.findIndex((l) => l.trimStart().startsWith(SETTINGS_START));
  const bodyEnd = settingsIdx === -1 ? lines.length : settingsIdx;
  const settings = settingsIdx === -1 ? '' : lines.slice(settingsIdx).join('\n');

  // Locate the first lane heading; everything before it is frontmatter.
  let firstLane = lines.findIndex((l, i) => i < bodyEnd && LANE_HEADING.test(l));
  if (firstLane === -1) firstLane = bodyEnd;
  const frontmatter = lines.slice(0, firstLane).join('\n');

  const lanes: Lane[] = [];
  let current: Lane | undefined;
  for (let i = firstLane; i < bodyEnd; i++) {
    const line = lines[i];
    const heading = line.match(LANE_HEADING);
    if (heading) {
      current = { name: heading[1].trim(), cards: [] };
      lanes.push(current);
      continue;
    }
    const card = line.match(CARD_LINE);
    if (card && current) {
      const text = card[2];
      const parsed = parseWikilink(text);
      current.cards.push({
        rawLine: line,
        checked: card[1].toLowerCase() === 'x',
        ...(parsed ? { link: parsed } : {}),
      });
    }
  }

  return { frontmatter, lanes, settings };
}

/** Serializes the Board model back to markdown in canonical form. */
export function serializeBoard(board: Board): string {
  const parts: string[] = [];
  if (board.frontmatter) parts.push(board.frontmatter.replace(/\n+$/, ''), '');

  for (const lane of board.lanes) {
    parts.push(`## ${lane.name}`, '');
    for (const card of lane.cards) parts.push(card.rawLine);
    parts.push('');
  }

  if (board.settings) parts.push(board.settings.replace(/\n+$/, ''));
  return parts.join('\n');
}
