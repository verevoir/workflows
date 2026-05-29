import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fs as fsSource } from '@verevoir/sources/fs';
import { parseWikilink, resolveWikilink } from '../../src/obsidian/wikilink.js';

// Resolution runs through the @verevoir/sources fs adapter, in
// (root, relative-path) space — root is the vault, results are
// root-relative note paths.
const env = { token: '', forkOrg: '' };

describe('parseWikilink', () => {
  it('parses a bare wikilink', () => {
    expect(parseWikilink('[[Test Card]]')).toEqual({ target: 'Test Card' });
  });

  it('parses an aliased wikilink', () => {
    expect(parseWikilink('[[Wire adapter|Wire it up]]')).toEqual({
      target: 'Wire adapter',
      alias: 'Wire it up',
    });
  });

  it('parses a pathed wikilink target', () => {
    expect(parseWikilink('[[cards/Test Card]]')).toEqual({ target: 'cards/Test Card' });
  });

  it('extracts the first wikilink when surrounded by text', () => {
    expect(parseWikilink('see [[Test Card]] now')).toEqual({ target: 'Test Card' });
  });

  it('returns null for plain text with no link', () => {
    expect(parseWikilink('just a plain card')).toBeNull();
  });
});

describe('resolveWikilink', () => {
  let vault: string;
  let boardDir: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'obs-vault-'));
    boardDir = join(vault, 'TestBoard');
    mkdirSync(boardDir);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('resolves a note next to the board file', async () => {
    writeFileSync(join(boardDir, 'Test Card.md'), '# Test Card\n');
    expect(
      await resolveWikilink(fsSource, env, vault, 'Test Card', {
        boardDirRel: 'TestBoard',
        vaultFallback: false,
      })
    ).toBe('TestBoard/Test Card.md');
  });

  it('appends .md when the target omits it', async () => {
    writeFileSync(join(boardDir, 'Test Card.md'), '');
    expect(
      await resolveWikilink(fsSource, env, vault, 'Test Card', {
        boardDirRel: 'TestBoard',
        vaultFallback: false,
      })
    ).toBe('TestBoard/Test Card.md');
  });

  it('falls back to a vault-wide scan, preferring the shortest path', async () => {
    const deep = join(vault, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'Note.md'), 'deep');
    writeFileSync(join(vault, 'Note.md'), 'shallow');
    expect(
      await resolveWikilink(fsSource, env, vault, 'Note', {
        boardDirRel: 'TestBoard',
        vaultFallback: true,
      })
    ).toBe('Note.md');
  });

  it('skips dot-directories during the vault scan', async () => {
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'Hidden.md'), '');
    expect(
      await resolveWikilink(fsSource, env, vault, 'Hidden', {
        boardDirRel: 'TestBoard',
        vaultFallback: true,
      })
    ).toBeNull();
  });

  it('returns null when nothing resolves', async () => {
    expect(
      await resolveWikilink(fsSource, env, vault, 'Missing', {
        boardDirRel: 'TestBoard',
        vaultFallback: true,
      })
    ).toBeNull();
  });
});
