// @verevoir/workflows/obsidian — wikilink parsing + resolution
//
// Obsidian Kanban "linked note" cards reference a note by wikilink:
// `[[Target]]` or `[[Target|Alias]]`, optionally with a folder path in
// the target (`[[folder/Note]]`). The parsed target is resolved to a
// note file path — relative to the board folder first, then (when a
// vault root is configured) vault-wide, mirroring Obsidian's
// shortest-path resolution.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ParsedWikilink {
  target: string;
  alias?: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/;

/** Extracts the first wikilink from a board card line's text. Returns
 * null when the text contains no wikilink (a plain-text card). */
export function parseWikilink(text: string): ParsedWikilink | null {
  const match = text.match(WIKILINK);
  if (!match) return null;
  const inner = match[1];
  const pipe = inner.indexOf('|');
  if (pipe === -1) return { target: inner.trim() };
  return { target: inner.slice(0, pipe).trim(), alias: inner.slice(pipe + 1).trim() };
}

/** Resolves a wikilink target to an absolute note file path.
 *
 * Strategy (decision 5): try relative to the board folder (and the
 * configured card folder) first; if unresolved and a vault root is
 * given, scan the vault for a matching basename, preferring the
 * shortest path (Obsidian's default). Returns null when nothing
 * matches.
 *
 * The target may already carry an extension or a folder path; `.md`
 * is appended when absent. */
export function resolveWikilink(
  target: string,
  opts: { boardDir: string; cardDir?: string; vaultRoot?: string }
): string | null {
  const withExt = target.endsWith('.md') ? target : `${target}.md`;
  const basename = withExt.slice(withExt.lastIndexOf('/') + 1);

  const relativeCandidates = [join(opts.boardDir, withExt)];
  if (opts.cardDir) relativeCandidates.push(join(opts.cardDir, withExt));
  for (const candidate of relativeCandidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
  }

  if (opts.vaultRoot) {
    const hits = findByBasename(opts.vaultRoot, basename);
    if (hits.length > 0) {
      hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      return resolve(hits[0]);
    }
  }
  return null;
}

function findByBasename(root: string, basename: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .obsidian, .git, etc.
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === basename) out.push(full);
    }
  };
  walk(root);
  return out;
}
