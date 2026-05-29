// @verevoir/workflows/obsidian — wikilink parsing + resolution
//
// Obsidian Kanban "linked note" cards reference a note by wikilink:
// `[[Target]]` or `[[Target|Alias]]`, optionally with a folder path in
// the target (`[[folder/Note]]`). The parsed target is resolved to a
// note path — relative to the board folder first, then (when a vault
// fallback is enabled) vault-wide, mirroring Obsidian's shortest-path
// resolution.
//
// Resolution goes through a `@verevoir/sources` SourceAdapter (the `fs`
// adapter for local boards) rather than `node:fs` directly, so the same
// logic resolves links in a GitHub-hosted vault unchanged. All paths
// are root-relative, the space the SourceAdapter operates in.

import type { SourceAdapter, SourceEnv } from '@verevoir/sources';

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

export interface ResolveOpts {
  /** Board file's folder, relative to root ('' = root). */
  boardDirRel: string;
  /** Configured card folder, relative to root. */
  cardDirRel?: string;
  /** When true, fall back to a tree-wide scan if the relative
   * candidates miss. Off when no vault root is configured — matching
   * Obsidian's relative-only resolution without a vault. */
  vaultFallback: boolean;
}

/** Resolves a wikilink target to a note path *relative to root*, or
 * null. Tries the board folder (then the card folder) first; on a
 * miss, and when `vaultFallback` is on, scans the whole tree for a
 * matching basename, preferring the shortest path and skipping
 * dot-folders (`.obsidian`, `.git`, …). */
export async function resolveWikilink(
  source: SourceAdapter,
  env: SourceEnv,
  root: string,
  target: string,
  opts: ResolveOpts
): Promise<string | null> {
  const withExt = target.endsWith('.md') ? target : `${target}.md`;
  const base = withExt.slice(withExt.lastIndexOf('/') + 1);

  const candidates = [joinRel(opts.boardDirRel, withExt)];
  if (opts.cardDirRel !== undefined) candidates.push(joinRel(opts.cardDirRel, withExt));
  for (const rel of candidates) {
    if (await exists(source, env, root, rel)) return rel;
  }

  if (opts.vaultFallback) {
    const { entries } = await source.getRepoTree(env, root);
    const hits = entries
      .filter((e) => e.type === 'blob')
      .map((e) => e.path)
      .filter((p) => p.slice(p.lastIndexOf('/') + 1) === base && !hasDotSegment(p));
    if (hits.length > 0) {
      hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      return hits[0];
    }
  }
  return null;
}

/** Cheap existence check — lists the parent directory and looks for
 * the file, rather than reading its content. */
async function exists(
  source: SourceAdapter,
  env: SourceEnv,
  root: string,
  rel: string
): Promise<boolean> {
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash);
  const name = slash === -1 ? rel : rel.slice(slash + 1);
  try {
    const entries = await source.listFiles(env, root, dir);
    return entries.some((e) => e.name === name && e.type === 'file');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return false;
    throw err;
  }
}

function joinRel(dir: string, name: string): string {
  return dir && dir !== '.' ? `${dir}/${name}` : name;
}

function hasDotSegment(p: string): boolean {
  return p.split('/').some((seg) => seg.startsWith('.'));
}
