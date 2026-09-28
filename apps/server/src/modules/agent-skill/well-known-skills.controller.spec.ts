import { createHash } from 'crypto';

import { NotFoundException } from '@nestjs/common';

import {
  WellKnownSkillsController,
  frontmatterDescription,
} from './well-known-skills.controller';

describe('WellKnownSkillsController', () => {
  const controller = new WellKnownSkillsController();

  it('publishes every guide under the 0.2.0 discovery schema', () => {
    const index = controller.index();

    // A client that does not recognise the schema must not read the index at
    // all, so a typo here is an index nobody can install from.
    expect(index.$schema).toBe(
      'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    );
    expect(index.skills.map((entry) => entry.name)).toEqual([
      'working-vantik-issues',
      'working-vantik-knowledge',
    ]);
  });

  it('writes every entry the way a client will accept it', () => {
    // The rules the skills CLI drops an entry for, so an entry that breaks one
    // is a guide that silently fails to show up.
    for (const entry of controller.index().skills) {
      expect(entry.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.name.length).toBeLessThanOrEqual(64);
      expect(entry.type).toBe('skill-md');
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(1024);
      expect(entry.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it('points each entry at the route that serves it, relative to the index', () => {
    for (const entry of controller.index().skills) {
      // Resolved the way a client resolves it, from wherever it found the
      // index, so the same entry works at the origin and behind `/api`.
      const atOrigin = new URL(
        entry.url,
        'https://vantik.example/.well-known/agent-skills/index.json',
      );
      const behindProxy = new URL(
        entry.url,
        'https://vantik.example/api/.well-known/agent-skills/index.json',
      );

      expect(atOrigin.pathname).toBe(
        `/.well-known/agent-skills/${entry.name}/SKILL.md`,
      );
      expect(behindProxy.pathname).toBe(
        `/api/.well-known/agent-skills/${entry.name}/SKILL.md`,
      );
    }
  });

  it('digests the exact bytes it serves', () => {
    // Clients refuse a skill whose bytes do not match, so a digest taken of
    // anything but the served body is a guide that never installs.
    for (const entry of controller.index().skills) {
      const body = controller.skill(entry.name);
      const digest = createHash('sha256').update(body, 'utf8').digest('hex');

      expect(entry.digest).toBe(`sha256:${digest}`);
    }
  });

  it('serves each guide as the skill it names', () => {
    for (const entry of controller.index().skills) {
      const body = controller.skill(entry.name);

      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain(`\nname: ${entry.name}\n`);
    }
  });

  it('describes each guide with the description its skill carries', () => {
    const [issues, knowledge] = controller.index().skills;

    // The folded frontmatter, not the short line the file listing uses.
    expect(issues.description).toContain('tick the Definition of Done');
    expect(knowledge.description).toContain('remember one fact at a time');
    for (const entry of [issues, knowledge]) {
      expect(entry.description).not.toContain('\n');
      expect(entry.description).toBe(
        frontmatterDescription(controller.skill(entry.name)),
      );
    }
  });

  it('refuses a guide it does not serve', () => {
    for (const name of ['../../etc', 'SKILL.md', 'constructor', 'unknown']) {
      expect(() => controller.skill(name)).toThrow(NotFoundException);
    }
  });
});

describe('frontmatterDescription', () => {
  it('folds a block description onto one line', () => {
    expect(
      frontmatterDescription(
        [
          '---',
          'name: example',
          'description: >-',
          '  First line of it,',
          '  and the second.',
          'other: value',
          '---',
          '',
          '# Body',
        ].join('\n'),
      ),
    ).toBe('First line of it, and the second.');
  });

  it('reads a one-line description', () => {
    expect(
      frontmatterDescription(
        '---\nname: example\ndescription: Just this.\n---\n',
      ),
    ).toBe('Just this.');
  });

  it('finds nothing without frontmatter or a description', () => {
    expect(frontmatterDescription('# No frontmatter')).toBeUndefined();
    expect(frontmatterDescription('---\nname: x\n---\n')).toBeUndefined();
  });
});
