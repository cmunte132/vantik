import type { ContextPack } from './context-pack.service';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAgentPrompt } from './agent-prompt';
import { buildRevisionPrompt } from './review-prompt';
import { GUEST_TOOLS, sandboxEnvironment } from './sandbox-environment';

/**
 * Packages in the guest image that the agent has no use for by name: the
 * kernel, the entropy daemon, certificates, filesystem tools, and git, which
 * is installed but has no repository to work on, because the checkout carries
 * no `.git`.
 */
const NOT_TOOLS = [
  'linux-virt',
  'rng-tools',
  'ca-certificates',
  'e2fsprogs',
  'e2fsprogs-extra',
  'openssh',
  'git',
];

function pack(repo: ContextPack['repo'] = {}): ContextPack {
  return {
    version: 1,
    issue: {
      id: 'issue-1',
      key: 'ENG-42',
      title: 'Document how to run it',
      description: 'Add a Running locally section.',
      state: 'Todo',
      stateCategory: 'UNSTARTED',
      priority: 'low',
      labels: [],
      team: { id: 'team-1', identifier: 'ENG', name: 'Engineering' },
      project: null,
      url: null,
    },
    definitionOfDone: [],
    subTasks: [],
    relations: [],
    comments: [],
    links: [],
    repo,
    knowledge: [],
  };
}

describe('what the agent is told about its sandbox', () => {
  it('names every tool the guest image installs, and no other', () => {
    const config = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../sandbox-host/guest/build-config.json'),
        'utf8',
      ),
    );
    const installed: string[] = config.alpine.rootfsPackages;
    const named = GUEST_TOOLS.flatMap((tool) => tool.packages);

    expect(named.filter((name) => !installed.includes(name))).toEqual([]);
    expect(
      installed.filter(
        (name) => !named.includes(name) && !NOT_TOOLS.includes(name),
      ),
    ).toEqual([]);
  });

  it('names only npm tools the image bakes in', () => {
    const config = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../sandbox-host/guest/build-config.json'),
        'utf8',
      ),
    );
    const install: string = config.postBuild.commands.find((command: string) =>
      command.startsWith('npm install -g'),
    );
    const baked = install
      .split(' ')
      .filter((word) => /^@?[\w./-]+@/.test(word))
      .map((word) => word.slice(0, word.lastIndexOf('@')));

    for (const name of GUEST_TOOLS.flatMap((tool) => tool.npm ?? [])) {
      expect(baked).toContain(name);
    }
  });

  it('says the checkout has no git, so the agent does not try', () => {
    const text = sandboxEnvironment(pack()).join('\n');

    expect(text).toContain('/workspace/repo');
    expect(text).toContain('no `.git`');
  });

  it('says which setup ran, or that none did', () => {
    expect(
      sandboxEnvironment(pack({ setupCommands: ['npm ci'] })).join('\n'),
    ).toContain('Setup already ran: `npm ci`');
    expect(sandboxEnvironment(pack()).join('\n')).toContain(
      'No setup commands ran',
    );
  });

  it('names the hosts the module opened, beside the npm registry', () => {
    const text = sandboxEnvironment(
      pack({ egressHosts: ['proxy.golang.org'] }),
    ).join('\n');

    expect(text).toContain('the npm registry, and `proxy.golang.org`');
  });

  it('is in the first prompt and in the revision prompt', () => {
    expect(buildAgentPrompt(pack())).toContain('## Your environment');
    expect(
      buildRevisionPrompt({
        pack: pack(),
        pass: 2,
        findings: [],
        verification: [],
      }),
    ).toContain('## Your environment');
  });

  it('names every code tool the extension registers', () => {
    const text = sandboxEnvironment(pack()).join('\n');
    for (const tool of [
      'code_definition',
      'code_references',
      'code_hover',
      'code_symbols',
      'code_diagnostics',
    ]) {
      expect(text).toContain(`\`${tool}\``);
    }
  });
});
