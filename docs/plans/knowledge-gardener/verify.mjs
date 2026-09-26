#!/usr/bin/env node
/**
 * Checks the knowledge gardener plan against the repository.
 *
 * A criterion in checklist.json passes on evidence this script can see, never
 * on anybody's say-so:
 *
 * - `test`: a unit test whose name carries the criterion's tag, `[KG-2.4]`,
 *   passed in the suites run below, and no test with that tag failed.
 * - `file`: a file matches a pattern.
 * - `log`:  PROGRESS.md matches a pattern.
 *
 * The suites are run here rather than trusted from an earlier run, and every
 * test in them has to pass, not only the tagged ones: a plan that lands by
 * breaking something else has not landed.
 *
 * The last line is the verdict, and it carries a hash of checklist.json and of
 * this file. The goal states the hash it expects, so passing by editing the
 * criteria or the checker shows up as a different hash.
 *
 * Usage:
 *   node docs/plans/knowledge-gardener/verify.mjs                 all phases
 *   node docs/plans/knowledge-gardener/verify.mjs --through 2     phases 0-2
 *   node docs/plans/knowledge-gardener/verify.mjs --phase 3       phase 3 only
 *   node docs/plans/knowledge-gardener/verify.mjs --list --phase 3
 *   node docs/plans/knowledge-gardener/verify.mjs --static        no suites; never a pass
 *   node docs/plans/knowledge-gardener/verify.mjs --skip-typecheck
 *   node docs/plans/knowledge-gardener/verify.mjs --results a.json b.json
 *        read Jest/Vitest JSON reports instead of running the suites
 *
 * Needs Node 20 and nothing else. Run `pnpm install` first so the suites can.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const CHECKLIST = join(HERE, 'checklist.json');
const PROGRESS = join(HERE, 'PROGRESS.md');

/** Where tests live. Each is walked for *.spec.* and *.test.* files. */
const TEST_ROOTS = ['apps/server/src', 'apps/webapp/src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo']);
const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TAG = /\[KG-\d+\.[0-9A-Z]+\]/g;

/**
 * What turbo builds before `pnpm test` (`test` depends on `^build`): the
 * packages the suites import from their `dist`. Calling the runners directly
 * skips turbo, so without this a fresh checkout fails to resolve
 * `@vantikhq/types` in the webapp suite.
 */
const BUILD_DEPENDENCIES = [
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=server^...',
    '--filter=webapp^...',
    '--filter=@vantikhq/agent-core^...',
    '--filter=@vantikhq/cli^...',
  ],
];

/**
 * The suites `pnpm test` runs, invoked directly so that the JSON flags reach
 * the runner rather than depending on how pnpm forwards arguments.
 */
const SUITES = [
  {
    name: 'server',
    prepare: ['pnpm', ['--filter', 'server', 'exec', 'prisma', 'generate']],
    run: (out) => [
      'pnpm',
      ['--filter', 'server', 'exec', 'jest', '--json', `--outputFile=${out}`],
    ],
  },
  {
    name: 'agent-core',
    run: (out) => [
      'pnpm',
      [
        '--filter',
        '@vantikhq/agent-core',
        'exec',
        'jest',
        '--json',
        `--outputFile=${out}`,
      ],
    ],
  },
  {
    name: 'cli',
    run: (out) => [
      'pnpm',
      [
        '--filter',
        '@vantikhq/cli',
        'exec',
        'jest',
        '--passWithNoTests',
        '--json',
        `--outputFile=${out}`,
      ],
    ],
  },
  {
    name: 'webapp',
    run: (out) => [
      'pnpm',
      [
        '--filter',
        'webapp',
        'exec',
        'vitest',
        'run',
        '--reporter=json',
        `--outputFile=${out}`,
      ],
    ],
  },
];

function parseArgs(argv) {
  const args = {
    through: null,
    phase: null,
    list: false,
    static: false,
    skipTypecheck: false,
    results: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--through') args.through = Number(argv[++i]);
    else if (arg === '--phase') args.phase = Number(argv[++i]);
    else if (arg === '--list') args.list = true;
    else if (arg === '--static') args.static = true;
    else if (arg === '--skip-typecheck') args.skipTypecheck = true;
    else if (arg === '--results') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args.results.push(argv[++i]);
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  for (const key of ['through', 'phase']) {
    if (args[key] !== null && !Number.isInteger(args[key])) {
      console.error(`--${key} needs a phase number.`);
      process.exit(2);
    }
  }

  return args;
}

function specHash() {
  const hash = createHash('sha256');
  hash.update(readFileSync(CHECKLIST));
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  return hash.digest('hex').slice(0, 12);
}

function walk(dir, found = []) {
  if (!existsSync(dir)) return found;

  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);

    if (stat.isDirectory()) walk(path, found);
    else if (TEST_FILE.test(name)) found.push(path);
  }

  return found;
}

/** Tag -> the test files that mention it. */
function taggedFiles() {
  const tags = new Map();

  for (const root of TEST_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const text = readFileSync(file, 'utf8');

      for (const tag of new Set(text.match(TAG) ?? [])) {
        const id = tag.slice(1, -1);
        if (!tags.has(id)) tags.set(id, []);
        tags.get(id).push(relative(ROOT, file));
      }
    }
  }

  return tags;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

function tail(text, lines = 15) {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/** Reads a Jest or Vitest JSON report; both share this shape. */
function readReport(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const assertions = [];
  const brokenFiles = [];

  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      assertions.push({
        name: assertion.fullName ?? assertion.title ?? '',
        status: assertion.status,
      });
    }

    // A file that failed to load has a failed status and no assertions.
    if (file.status === 'failed' && !(file.assertionResults ?? []).length) {
      brokenFiles.push(relative(ROOT, file.name ?? '(unknown file)'));
    }
  }

  return { assertions, brokenFiles };
}

function runSuites(args) {
  const suites = [];
  const assertions = [];

  if (args.results.length) {
    for (const path of args.results) {
      const report = readReport(path);
      const failed = report.assertions.filter((a) => a.status === 'failed');
      suites.push({
        name: path,
        ok: failed.length === 0 && report.brokenFiles.length === 0,
        detail: `${report.assertions.length} tests, ${failed.length} failed, ${report.brokenFiles.length} files failed to load`,
      });
      assertions.push(...report.assertions);
    }
    return { suites, assertions };
  }

  const built = run(...BUILD_DEPENDENCIES);
  if (built.status !== 0) {
    for (const suite of SUITES) {
      suites.push({
        name: suite.name,
        ok: false,
        detail: `building the packages the suites depend on failed:\n${tail(built.output)}`,
      });
    }
    return { suites, assertions };
  }

  const dir = mkdtempSync(join(tmpdir(), 'kg-verify-'));

  for (const suite of SUITES) {
    if (suite.prepare) {
      const prepared = run(...suite.prepare);
      if (prepared.status !== 0) {
        suites.push({
          name: suite.name,
          ok: false,
          detail: `setup failed:\n${tail(prepared.output)}`,
        });
        continue;
      }
    }

    const out = join(dir, `${suite.name}.json`);
    const result = run(...suite.run(out));

    if (!existsSync(out)) {
      suites.push({
        name: suite.name,
        ok: false,
        detail: `no report written (exit ${result.status}):\n${tail(result.output)}`,
      });
      continue;
    }

    const report = readReport(out);
    const failed = report.assertions.filter((a) => a.status === 'failed');
    suites.push({
      name: suite.name,
      ok:
        result.status === 0 &&
        failed.length === 0 &&
        report.brokenFiles.length === 0,
      detail:
        `${report.assertions.length} tests, ${failed.length} failed` +
        (report.brokenFiles.length
          ? `, failed to load: ${report.brokenFiles.join(', ')}`
          : '') +
        (failed.length
          ? `\n    ${failed
              .slice(0, 10)
              .map((a) => a.name)
              .join('\n    ')}`
          : ''),
    });
    assertions.push(...report.assertions);
  }

  return { suites, assertions };
}

function checkTest(id, tags, assertions, staticOnly) {
  const files = tags.get(id);

  if (!files) return { ok: false, why: `no test is tagged [${id}]` };
  if (staticOnly) {
    return { ok: false, why: `tagged in ${files.join(', ')}; not run (--static)` };
  }

  const tagged = assertions.filter((a) => a.name.includes(`[${id}]`));
  const passed = tagged.filter((a) => a.status === 'passed');
  const failed = tagged.filter((a) => a.status === 'failed');

  if (failed.length) {
    return { ok: false, why: `${failed.length} tagged test(s) failed: ${failed[0].name}` };
  }
  if (!passed.length) {
    return {
      ok: false,
      why: `tagged in ${files.join(', ')} but no tagged test passed (skipped, todo, or not in a suite)`,
    };
  }
  return { ok: true, why: `${passed.length} tagged test(s) passed` };
}

function checkFile(check) {
  const path = join(ROOT, check.path);
  if (!existsSync(path)) return { ok: false, why: `${check.path} does not exist` };
  const ok = new RegExp(check.pattern).test(readFileSync(path, 'utf8'));
  return { ok, why: ok ? `${check.path} matches` : `${check.path} does not match /${check.pattern}/` };
}

function checkLog(check) {
  if (!existsSync(PROGRESS)) return { ok: false, why: 'PROGRESS.md does not exist' };
  const ok = new RegExp(check.pattern).test(readFileSync(PROGRESS, 'utf8'));
  return { ok, why: ok ? 'PROGRESS.md records it' : `PROGRESS.md has no "${check.pattern}"` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checklist = JSON.parse(readFileSync(CHECKLIST, 'utf8'));
  const hash = specHash();

  const selected = checklist.criteria.filter((c) => {
    if (args.phase !== null) return c.phase === args.phase;
    if (args.through !== null) return c.phase <= args.through;
    return true;
  });

  if (!selected.length) {
    console.error('No criteria in that range.');
    process.exit(2);
  }

  const phases = [...new Set(selected.map((c) => c.phase))];
  const range =
    phases.length === 1
      ? `phase ${phases[0]}`
      : `phases ${Math.min(...phases)}-${Math.max(...phases)}`;

  if (args.list) {
    for (const c of selected) {
      console.log(`${c.id}  ${c.title}\n  ${c.detail}\n`);
    }
    return;
  }

  console.log(`knowledge-gardener verify: ${range}`);
  console.log(`spec-hash: ${hash}\n`);

  const tags = taggedFiles();
  const known = new Set(checklist.criteria.map((c) => c.id));
  const unknownTags = [...tags.keys()].filter((id) => !known.has(id));

  let suites = [];
  let assertions = [];
  if (!args.static) ({ suites, assertions } = runSuites(args));

  let typecheck = null;
  if (!args.static && !args.skipTypecheck && !args.results.length) {
    const result = run('pnpm', ['typecheck']);
    typecheck = { ok: result.status === 0, output: result.output };
  }

  let passing = 0;
  for (const criterion of selected) {
    const results = criterion.checks.map((check) => {
      if (check.type === 'test') return checkTest(criterion.id, tags, assertions, args.static);
      if (check.type === 'file') return checkFile(check);
      if (check.type === 'log') return checkLog(check);
      return { ok: false, why: `unknown check type ${check.type}` };
    });
    const ok = results.every((r) => r.ok);
    if (ok) passing++;

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${criterion.id.padEnd(7)} ${criterion.title}`);
    for (const r of results) {
      if (!r.ok) console.log(`        - ${r.why}`);
    }
  }

  console.log('');
  for (const suite of suites) {
    console.log(`suite ${suite.name}: ${suite.ok ? 'ok' : 'FAILED'} (${suite.detail})`);
  }
  if (typecheck) {
    console.log(`typecheck: ${typecheck.ok ? 'ok' : 'FAILED'}`);
    if (!typecheck.ok) console.log(tail(typecheck.output));
  } else if (!args.static) {
    console.log(`typecheck: skipped${args.results.length ? ' (--results)' : ''}`);
  }
  if (unknownTags.length) {
    console.log(`warning: tests carry tags no criterion defines: ${unknownTags.join(', ')}`);
  }

  // Only a full run can pass. The other modes are for looking, and a verdict
  // from supplied reports or a skipped typecheck is not evidence of anything.
  const fullRun = !args.static && !args.skipTypecheck && !args.results.length;
  const pass =
    fullRun &&
    passing === selected.length &&
    suites.every((s) => s.ok) &&
    Boolean(typecheck?.ok);

  console.log(`\ncriteria: ${passing}/${selected.length} pass`);
  const note = args.static
    ? ' (static check only; never a pass)'
    : args.results.length
      ? ' (supplied reports; never a pass)'
      : args.skipTypecheck
        ? ' (typecheck skipped; never a pass)'
        : '';
  console.log(
    `KNOWLEDGE-GARDENER VERIFY: ${pass ? 'PASS' : 'FAIL'} ${range} spec-hash ${hash}${note}`,
  );
  process.exit(pass ? 0 : 1);
}

main();
