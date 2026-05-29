import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWikilink, resolveWikilink } from '../../src/obsidian/wikilink.js';

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

  it('resolves a note next to the board file', () => {
    const notePath = join(boardDir, 'Test Card.md');
    writeFileSync(notePath, '# Test Card\n');
    expect(resolveWikilink('Test Card', { boardDir })).toBe(notePath);
  });

  it('appends .md when the target omits it', () => {
    writeFileSync(join(boardDir, 'Test Card.md'), '');
    expect(resolveWikilink('Test Card', { boardDir })).toBe(join(boardDir, 'Test Card.md'));
  });

  it('falls back to a vault-wide scan, preferring the shortest path', () => {
    const deep = join(vault, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const shallow = join(vault, 'Note.md');
    writeFileSync(join(deep, 'Note.md'), 'deep');
    writeFileSync(shallow, 'shallow');
    expect(resolveWikilink('Note', { boardDir, vaultRoot: vault })).toBe(shallow);
  });

  it('skips dot-directories during the vault scan', () => {
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'Hidden.md'), '');
    expect(resolveWikilink('Hidden', { boardDir, vaultRoot: vault })).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    expect(resolveWikilink('Missing', { boardDir, vaultRoot: vault })).toBeNull();
  });
});
