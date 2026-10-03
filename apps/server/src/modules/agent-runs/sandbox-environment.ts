import type { ContextPack } from './context-pack.service';

/**
 * The tools the guest image installs, as a person would name them.
 *
 * Kept in step with `apps/sandbox-host/guest/build-config.json` by a test, so
 * the prompt cannot promise a tool the image dropped or keep quiet about one
 * it added.
 */
export const GUEST_TOOLS: Array<{
  packages: string[];
  /** Installed globally from npm by the image's post-build step. */
  npm?: string[];
  name: string;
}> = [
  { packages: ['bash'], name: 'bash' },
  { packages: ['nodejs', 'npm'], name: 'Node.js with npm' },
  { packages: ['python3', 'uv'], name: 'Python 3 with uv' },
  { packages: ['ripgrep'], name: 'ripgrep (`rg`)' },
  { packages: ['curl'], name: 'curl' },
  { packages: ['fd'], name: 'fd' },
  { packages: ['ast-grep'], name: 'ast-grep (structural search)' },
  { packages: ['jq'], name: 'jq' },
  {
    packages: [],
    npm: ['typescript', 'pyright'],
    name: 'TypeScript (`tsc`) and Pyright (`pyright`) for type checking',
  },
];

/**
 * What the sandbox is, said to the agent before it starts.
 *
 * Without it the agent learns its surroundings by trial: `git status` in a
 * checkout with no `.git`, `which pnpm` in an image with no pnpm, an install
 * from a registry the network refuses. Each probe fails, each failure is a red
 * line on the run's timeline, and each one costs a turn. These are facts the
 * server already holds, so it states them.
 */
export function sandboxEnvironment(pack: ContextPack): string[] {
  const setup = pack.repo?.setupCommands ?? [];
  const hosts = pack.repo?.egressHosts ?? [];
  const scope = pack.repo?.pathPrefixes ?? [];

  return [
    '## Your environment',
    '',
    'You are in a sandbox, an Alpine Linux virtual machine. These are facts,',
    'so you do not need to probe for them:',
    '',
    '- The repository is at `/workspace/repo`. It is a copy of the files at',
    '  the base branch with no `.git`, so `git status`, `git log` and',
    '  `git diff` do not work here. You do not need them: the host commits and',
    '  pushes your work.',
    `- Installed: ${GUEST_TOOLS.map((tool) => tool.name).join(', ')}. If`,
    '  package.json names a `packageManager`, that one is installed too.',
    '  Nothing else is: no docker, and no other package manager.',
    setup.length
      ? `- Setup already ran: ${setup.map((command) => `\`${command}\``).join(', ')}.`
      : '- No setup commands ran, so dependencies are not installed. Install' +
        ' them only if you need to run something.',
    `- The network reaches only the model provider, the npm registry${
      hosts.length
        ? `, and ${hosts.map((host) => `\`${host}\``).join(', ')}`
        : ''
    }. Everything else is refused, so an install from anywhere else (PyPI,` +
      ' a git host) fails. Do not retry a download that was refused.',
    '- Look before you read: `ls` a directory before you `cat` files in it.',
    '  One command that fails makes the whole line fail.',
    scope.length
      ? `- Change files only under ${scope.map((prefix) => `\`${prefix}\``).join(', ')}. The host refuses to push work that changes anything else, so a change outside those paths loses the whole run.`
      : '- You may change any file in the repository.',
    '- Never change CI configuration (`.github/workflows`, `.forgejo/workflows`,',
    '  `.gitlab-ci.yml` and the like). The host refuses to push it.',
    '- You have no Vantik account here, and need none. `vantik_issue` reads',
    '  the issue and its Definition of Done, and `vantik_knowledge` what the',
    '  workspace knows. `vantik_note`, `vantik_criterion_met` and',
    '  `vantik_remember` queue writes the host applies for you.',
    '- For TypeScript, JavaScript and Python, ask the language server instead',
    '  of grepping: `code_definition`, `code_references` (before you change a',
    '  signature), `code_hover` for a type, `code_symbols` for an outline or a',
    '  declaration by name, and `code_diagnostics` for a file. Each takes a',
    '  path, a line, and the name on it. Errors in a file you write or edit are',
    '  shown with the result, so fix them before you move on. If a tool says',
    '  its server is unavailable, use `rg` and the checks.',
  ];
}
