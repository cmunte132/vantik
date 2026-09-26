import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

import { SKILLS, servedBody } from './agent-skill.catalogue';

/** `skills/` at the root of the repository, as a git install reads it. */
const REPOSITORY_SKILLS = join(__dirname, '../../../../../skills');

/** Every directory there holding a SKILL.md: what the skills CLI offers. */
function repositorySkills(): string[] {
  return readdirSync(REPOSITORY_SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(REPOSITORY_SKILLS, name, 'SKILL.md')));
}

describe('the agent guides in the repository', () => {
  it('offers the same guides from the repository as from the server', () => {
    // `npx skills add cmunte132/vantik` and `npx skills add <your host>` are
    // the same install from two sources. A guide in one and not the other is
    // a guide half the people installing it never see.
    expect(repositorySkills().sort()).toEqual(Object.keys(SKILLS).sort());
  });

  it('keeps nothing but SKILL.md in a skill directory', () => {
    // A git install copies the skill's whole directory into the user's
    // project, so the always-in-context form or a README kept here would land
    // beside the skill — an AGENTS.md among Codex's and Cursor's skills.
    for (const skill of repositorySkills()) {
      expect(readdirSync(join(REPOSITORY_SKILLS, skill))).toEqual(['SKILL.md']);
    }
  });

  it('serves every form of every guide from there', () => {
    for (const [skill, { files }] of Object.entries(SKILLS)) {
      for (const file of Object.keys(files)) {
        expect(servedBody(skill, file)).toEqual(expect.any(String));
      }
    }
  });
});
