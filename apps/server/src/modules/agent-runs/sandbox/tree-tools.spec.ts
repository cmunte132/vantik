import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TREE_TOOLS_SCRIPT } from './tree-tools';

/**
 * The script that tells the reviewer what changed.
 *
 * Run for real rather than asserted against as a string. This is shell that
 * only ever executes inside a microVM on a machine nobody is watching, written
 * for BusyBox — every other test in this repository would still pass if it were
 * broken, and the symptom would be a reviewer quietly reviewing an empty diff
 * and accepting everything.
 *
 * `/bin/sh` on the CI image is not BusyBox ash, so this proves POSIX-correctness
 * rather than BusyBox-compatibility. That is the half that actually breaks: the
 * applets used here are all in the BusyBox set, and it is the shell constructs
 * that go wrong.
 */

let root: string;
let base: string;
let repo: string;
let script: string;

function write(dir: string, path: string, contents: string) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function run(mode: 'hash' | 'diff'): string {
  return execFileSync('sh', [script, mode], {
    env: { ...process.env, VANTIK_BASE_DIR: base, VANTIK_REPO_DIR: repo },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tree-tools-'));
  base = join(root, 'base');
  repo = join(root, 'repo');
  script = join(root, 'tree-tools.sh');

  mkdirSync(base, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(script, TREE_TOOLS_SCRIPT);

  // The starting point: the same tree in both places, which is what the guest
  // has the moment before the agent touches anything.
  for (const dir of [base, repo]) {
    write(dir, 'src/parser.ts', 'export const parse = () => 1;\n');
    write(dir, 'README.md', '# thing\n');
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the diff the reviewer is given', () => {
  it('says nothing when nothing was changed', () => {
    expect(run('diff').trim()).toBe('');
  });

  it('shows an edit as a diff against the base', () => {
    write(repo, 'src/parser.ts', 'export const parse = () => 2;\n');

    const diff = run('diff');

    expect(diff).toContain('=== src/parser.ts ===');
    expect(diff).toContain('-export const parse = () => 1;');
    expect(diff).toContain('+export const parse = () => 2;');
  });

  it('marks a new file as new rather than as a rewrite', () => {
    write(repo, 'src/parser.spec.ts', 'it("parses", () => {});\n');

    const diff = run('diff');

    expect(diff).toContain('=== src/parser.spec.ts (new file) ===');
    expect(diff).toContain('+it("parses", () => {});');
  });

  it('reports a deletion, which a listing of the tree could not', () => {
    rmSync(join(repo, 'README.md'));

    expect(run('diff')).toContain('=== README.md (deleted) ===');
  });

  it('leaves out what a setup command generated', () => {
    // `npm install` runs before the agent does, and a diff that opened with
    // forty thousand added files under node_modules is a diff nobody reads.
    write(repo, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
    write(repo, '.git/HEAD', 'ref: refs/heads/main\n');
    write(repo, '.pi/session.json', '{}\n');

    const diff = run('diff');

    expect(diff).not.toContain('node_modules');
    expect(diff).not.toContain('.git/HEAD');
    expect(diff).not.toContain('.pi/session');
  });

  it('does not prune a directory a repository is entitled to track', () => {
    // `dist` is generated in most repositories and committed in some. Pruning
    // it would hide a real change in the ones that commit it.
    write(base, 'dist/bundle.js', 'old\n');
    write(repo, 'dist/bundle.js', 'new\n');

    expect(run('diff')).toContain('=== dist/bundle.js ===');
  });

  it('names a large file as changed instead of pasting it', () => {
    write(repo, 'src/generated.ts', 'x'.repeat(50_000));

    const diff = run('diff');

    expect(diff).toContain('src/generated.ts');
    expect(diff).toContain('too large to show');
    expect(diff.length).toBeLessThan(2000);
  });

  it('survives a path with a space in it', () => {
    write(repo, 'docs/release notes.md', 'shipped\n');

    expect(run('diff')).toContain('=== docs/release notes.md (new file) ===');
  });
});

describe('the tree hash', () => {
  it('is stable across two reads of an unchanged tree', () => {
    // The whole use of it is deciding that a pass changed nothing, so a hash
    // that moves on its own would stop every run after two passes.
    expect(run('hash')).toBe(run('hash'));
  });

  it('moves when a file changes', () => {
    const before = run('hash');
    write(repo, 'src/parser.ts', 'export const parse = () => 2;\n');

    expect(run('hash')).not.toBe(before);
  });

  it('moves when a file is added', () => {
    const before = run('hash');
    write(repo, 'src/new.ts', 'export const x = 1;\n');

    expect(run('hash')).not.toBe(before);
  });

  it('ignores what a setup command generated', () => {
    // Otherwise the hash changes every pass for reasons the agent had nothing
    // to do with, and the oscillation check never fires.
    const before = run('hash');
    write(repo, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');

    expect(run('hash')).toBe(before);
  });

  it('is a hex digest the executor will accept', () => {
    // The executor refuses anything that does not look like one, so a change
    // here that emitted a filename beside the digest would silently disable
    // the oscillation check rather than fail.
    expect(run('hash').trim()).toMatch(/^[0-9a-f]{32,}$/);
  });
});
