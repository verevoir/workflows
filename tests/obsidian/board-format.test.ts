import { describe, it, expect } from 'vitest';
import { parseBoard, serializeBoard } from '../../src/obsidian/board-format.js';

// A board shaped like the real Obsidian Kanban output: frontmatter with
// blank lines around the marker, lanes, and a fence-wrapped settings block.
const BOARD = `---

kanban-plugin: board

---

## To Do

- [ ] [[Test Card]]
- [ ] a plain card

## In Progress

- [x] [[Done Thing|done]]


%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-note-folder":"TestBoard"}
\`\`\`
%%`;

describe('parseBoard', () => {
  it('extracts lanes in order', () => {
    const board = parseBoard(BOARD);
    expect(board.lanes.map((l) => l.name)).toEqual(['To Do', 'In Progress']);
  });

  it('parses link cards and plain-text cards', () => {
    const board = parseBoard(BOARD);
    const todo = board.lanes[0];
    expect(todo.cards).toHaveLength(2);
    expect(todo.cards[0].link).toEqual({ target: 'Test Card' });
    expect(todo.cards[1].link).toBeUndefined();
  });

  it('detects checked state and aliased links', () => {
    const board = parseBoard(BOARD);
    const card = board.lanes[1].cards[0];
    expect(card.checked).toBe(true);
    expect(card.link).toEqual({ target: 'Done Thing', alias: 'done' });
  });

  it('preserves the frontmatter block verbatim', () => {
    const board = parseBoard(BOARD);
    expect(board.frontmatter).toContain('kanban-plugin: board');
    expect(serializeBoard(board)).toContain('---\n\nkanban-plugin: board\n\n---');
  });

  it('preserves the settings block verbatim', () => {
    const board = parseBoard(BOARD);
    expect(serializeBoard(board)).toContain(
      '%% kanban:settings\n```\n{"kanban-plugin":"board","new-note-folder":"TestBoard"}\n```\n%%'
    );
  });
});

describe('serializeBoard', () => {
  it('round-trips lane and card structure', () => {
    const board = parseBoard(BOARD);
    const reparsed = parseBoard(serializeBoard(board));
    expect(reparsed.lanes.map((l) => l.name)).toEqual(['To Do', 'In Progress']);
    expect(reparsed.lanes[0].cards.map((c) => c.rawLine)).toEqual([
      '- [ ] [[Test Card]]',
      '- [ ] a plain card',
    ]);
    expect(reparsed.lanes[1].cards[0].checked).toBe(true);
  });

  it('is idempotent — serialize is stable across a re-parse', () => {
    const once = serializeBoard(parseBoard(BOARD));
    const twice = serializeBoard(parseBoard(once));
    expect(twice).toBe(once);
  });
});
