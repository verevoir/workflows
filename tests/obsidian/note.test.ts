import { describe, it, expect } from 'vitest';
import {
  parseNote,
  serializeNote,
  editNoteFrontmatter,
  setNoteBody,
} from '../../src/obsidian/note.js';

const NOTE = `---
id: "card-20260529-133731"
date: "2026-05-29"
tags:
  - kanban-card
---
# Test Card
`;

describe('parseNote', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = parseNote(NOTE);
    expect(frontmatter['id']).toBe('card-20260529-133731');
    expect(frontmatter['tags']).toEqual(['kanban-card']);
    expect(body).toBe('# Test Card\n');
  });

  it('treats a note with no frontmatter as all body', () => {
    const { frontmatter, body } = parseNote('# Just a body\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a body\n');
  });
});

describe('editNoteFrontmatter', () => {
  it('sets a new key while preserving existing keys and body', () => {
    const out = editNoteFrontmatter(NOTE, { title: 'Renamed Card' });
    const { frontmatter, body } = parseNote(out);
    expect(frontmatter['title']).toBe('Renamed Card');
    expect(frontmatter['id']).toBe('card-20260529-133731');
    expect(frontmatter['tags']).toEqual(['kanban-card']);
    expect(body).toBe('# Test Card\n');
  });

  it('overwrites an existing key', () => {
    const out = editNoteFrontmatter(NOTE, { tags: ['infra', 'adapter'] });
    expect(parseNote(out).frontmatter['tags']).toEqual(['infra', 'adapter']);
  });

  it('adds frontmatter to a note that had none', () => {
    const out = editNoteFrontmatter('# Body only\n', { id: 'x1' });
    const { frontmatter, body } = parseNote(out);
    expect(frontmatter['id']).toBe('x1');
    expect(body).toBe('# Body only\n');
  });
});

describe('setNoteBody', () => {
  it('replaces the body and preserves frontmatter', () => {
    const out = setNoteBody(NOTE, 'New body text\n');
    const { frontmatter, body } = parseNote(out);
    expect(frontmatter['id']).toBe('card-20260529-133731');
    expect(body).toBe('New body text\n');
  });
});

describe('serializeNote', () => {
  it('builds a note from frontmatter and body', () => {
    const out = serializeNote({ id: 'abc', title: 'Hi' }, 'Body\n');
    const { frontmatter, body } = parseNote(out);
    expect(frontmatter['id']).toBe('abc');
    expect(frontmatter['title']).toBe('Hi');
    expect(body).toBe('Body\n');
  });
});
