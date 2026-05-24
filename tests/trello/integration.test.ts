// Integration test against the real Trello API. Skipped unless
// TRELLO_API_KEY + TRELLO_API_TOKEN + TRELLO_TEST_BOARD_URL are all
// present in the environment — keeps CI green without credentials.
//
// Reads only. No createCard / updateCard / moveCard / addComment.

import { describe, it, expect } from 'vitest';
import { trello, envFromTrelloProcessEnv } from '../../src/trello/index.js';

const RUN_INTEGRATION =
  !!process.env.TRELLO_API_KEY &&
  !!process.env.TRELLO_API_TOKEN &&
  !!process.env.TRELLO_REFERER &&
  !!process.env.TRELLO_TEST_BOARD_URL;

describe.runIf(RUN_INTEGRATION)('Trello adapter — real-API smoke', () => {
  const env = envFromTrelloProcessEnv()!;
  const boardUrl = process.env.TRELLO_TEST_BOARD_URL!;

  it('listColumns returns at least one column with the expected shape', async () => {
    const columns = await trello.listColumns(env, boardUrl);
    expect(columns.length).toBeGreaterThan(0);
    const c = columns[0];
    expect(typeof c.id).toBe('string');
    expect(typeof c.name).toBe('string');
    // position is optional but Trello provides it
    expect(typeof c.position).toBe('number');
  });

  it('listCards returns cards with the expected shape', async () => {
    const cards = await trello.listCards(env, boardUrl);
    // Empty board is a valid result; just check the shape if any cards exist
    if (cards.length === 0) return;
    const c = cards[0];
    expect(typeof c.id).toBe('string');
    expect(typeof c.title).toBe('string');
    expect(typeof c.body).toBe('string');
    expect(typeof c.columnId).toBe('string');
    expect(Array.isArray(c.assigneeIds)).toBe(true);
    expect(Array.isArray(c.labels)).toBe(true);
    // parentId should be undefined (Trello is flat)
    expect(c.parentId).toBeUndefined();
  });

  it('listCards filtered by columnId returns only cards in that column', async () => {
    const columns = await trello.listColumns(env, boardUrl);
    const target = columns[0];
    const filtered = await trello.listCards(env, boardUrl, { columnId: target.id });
    for (const card of filtered) {
      expect(card.columnId).toBe(target.id);
    }
  });

  it('getCard fetches a single card matching listCards', async () => {
    const cards = await trello.listCards(env, boardUrl);
    if (cards.length === 0) return;
    const single = await trello.getCard(env, boardUrl, cards[0].id);
    expect(single.id).toBe(cards[0].id);
    expect(single.title).toBe(cards[0].title);
  });

  it('listComments returns an array (may be empty)', async () => {
    const cards = await trello.listCards(env, boardUrl);
    if (cards.length === 0) return;
    const comments = await trello.listComments(env, boardUrl, cards[0].id);
    expect(Array.isArray(comments)).toBe(true);
    if (comments.length > 0) {
      const c = comments[0];
      expect(typeof c.id).toBe('string');
      expect(typeof c.body).toBe('string');
      expect(typeof c.date).toBe('string');
    }
  });

  it('listCustomFields returns [] at v0', async () => {
    const fields = await trello.listCustomFields(env, boardUrl);
    expect(fields).toEqual([]);
  });
});
