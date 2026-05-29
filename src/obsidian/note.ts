// @verevoir/workflows/obsidian — card-note format layer
//
// A card note is a markdown file with optional YAML frontmatter between
// `---` fences, followed by the body. The linked note is the source of
// truth for a card's id / title / labels / due date (frontmatter) and
// body (markdown after the frontmatter).
//
// Frontmatter is handled with the `yaml` package's Document API so that
// unmanaged keys survive edits — the adapter only ever touches the few
// keys it manages.

import { parseDocument, Document } from 'yaml';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Splits a note into its frontmatter map and body. A note with no
 * frontmatter fence yields an empty map and the whole text as body. */
export function parseNote(text: string): ParsedNote {
  const match = text.match(FRONTMATTER);
  if (!match) return { frontmatter: {}, body: text };
  const doc = parseDocument(match[1]);
  const frontmatter = (doc.toJS() ?? {}) as Record<string, unknown>;
  return { frontmatter, body: text.slice(match[0].length) };
}

/** Applies frontmatter key updates, preserving every other key and the
 * body. Adds a frontmatter block when the note had none. */
export function editNoteFrontmatter(text: string, updates: Record<string, unknown>): string {
  const match = text.match(FRONTMATTER);
  const doc = match ? parseDocument(match[1]) : new Document({});
  for (const [key, value] of Object.entries(updates)) doc.set(key, value);
  const body = match ? text.slice(match[0].length) : text;
  return `---\n${doc.toString()}---\n${body}`;
}

/** Replaces the body, preserving the frontmatter block verbatim. */
export function setNoteBody(text: string, body: string): string {
  const match = text.match(FRONTMATTER);
  if (!match) return body;
  return match[0] + body;
}

/** Builds a fresh note from a frontmatter map and body. */
export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  const doc = new Document(frontmatter);
  return `---\n${doc.toString()}---\n${body}`;
}
