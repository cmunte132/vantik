import { NotFoundException } from '@nestjs/common';

import { AgentSkillController } from './agent-skill.controller';

function fakeResponse() {
  const sent: {
    body?: string;
    headers: Record<string, string>;
    type?: string;
  } = { headers: {} };

  return {
    sent,
    type(value: string) {
      sent.type = value;
      return this;
    },
    setHeader(name: string, value: string) {
      sent.headers[name] = value;
      return this;
    },
    send(body: string) {
      sent.body = body;
    },
  };
}

describe('AgentSkillController', () => {
  const controller = new AgentSkillController();

  it('lists the files it can serve', () => {
    const listing = controller.list();

    expect(listing.name).toBe('working-vantik-issues');
    expect(listing.files.map((f) => f.file)).toEqual(
      expect.arrayContaining(['SKILL.md', 'AGENTS.md']),
    );
  });

  it('serves a file as a download', () => {
    const response = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller.download('SKILL.md', response as any);

    expect(response.sent.headers['Content-Disposition']).toBe(
      'attachment; filename="SKILL.md"',
    );
    expect(response.sent.body).toContain('working-vantik-issues');
  });

  it('serves an AGENTS.md ready to append, without the note to humans', () => {
    const response = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller.download('AGENTS.md', response as any);

    const body = response.sent.body ?? '';
    // This one usually lands at the end of an AGENTS.md the reader already
    // keeps, so it has to start with the guidance rather than with a note
    // telling them to paste the section below.
    expect(body.startsWith('## Working Vantik issues')).toBe(true);
    expect(body).not.toContain('<!--');
  });

  it('serves a Cursor rule derived from the same snippet', () => {
    const response = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller.download('working-vantik-issues.mdc', response as any);

    const body = response.sent.body ?? '';
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('alwaysApply: true');
    // The guidance itself survives the conversion, and the note aimed at
    // whoever was choosing a format does not.
    expect(body).toContain('## Working Vantik issues');
    expect(body).not.toContain('<!--');
    expect(response.sent.headers['Content-Disposition']).toBe(
      'attachment; filename="working-vantik-issues.mdc"',
    );
  });

  it('serves a CLAUDE.md without the note about which form to pick', () => {
    const response = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller.download('CLAUDE.md', response as any);

    const body = response.sent.body ?? '';
    expect(body.startsWith('## Working Vantik issues')).toBe(true);
    expect(body).not.toContain('<!--');
  });

  it('lists every guide, not just the default one', () => {
    const listing = controller.list();

    // A client that only knew about the issues guide still reads the top-level
    // name and files; a client wanting both reads `skills`.
    expect(listing.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining([
        'working-vantik-issues',
        'working-vantik-knowledge',
      ]),
    );
  });

  it('serves the knowledge guide under its own prefix', () => {
    const response = fakeResponse();

    controller.downloadFromSkill(
      'working-vantik-knowledge',
      'SKILL.md',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response as any,
    );

    expect(response.sent.body).toContain('working-vantik-knowledge');
  });

  it('derives the knowledge Cursor rule with its own description', () => {
    const response = fakeResponse();

    controller.downloadFromSkill(
      'working-vantik-knowledge',
      'working-vantik-knowledge.mdc',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response as any,
    );

    const body = response.sent.body ?? '';
    // Both guides derive their rule from the same helper, so the wrong
    // description here would be the first sign the two had been conflated.
    expect(body).toContain('description: How to use the Vantik knowledge bank');
    expect(body).not.toContain('<!--');
  });

  it('refuses a guide it does not serve', () => {
    const response = fakeResponse();

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.downloadFromSkill('../../etc', 'SKILL.md', response as any),
    ).toThrow(NotFoundException);

    expect(response.sent.body).toBeUndefined();
  });

  it('refuses anything outside the served set', () => {
    const response = fakeResponse();

    for (const name of ['../../.env', 'package.json', 'SKILL.md.bak']) {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller.download(name, response as any),
      ).toThrow(NotFoundException);
    }

    expect(response.sent.body).toBeUndefined();
  });
});
