import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';

import {
  DEFAULT_SKILL,
  SKILLS,
  listSkill,
  servedBody,
} from './agent-skill.catalogue';

/**
 * Serves the agent guides one file at a time, in every form each is kept in.
 *
 * Installing a guide as a skill goes through the discovery index instead — see
 * `WellKnownSkillsController`. This is what is left for the forms a skill
 * installer does not deal in: the always-in-context snippet appended to an
 * AGENTS.md or a CLAUDE.md, which the Agents screen offers for anyone whose
 * agent works quietly with the skill loaded on demand, and the derived Cursor
 * rule, kept for installs that already fetch it.
 *
 * Deliberately unauthenticated: these are fixed documents shipped in the image,
 * identical for every workspace and containing nothing about anyone's data.
 * Requiring a token would also break the curl-and-append install, which is the
 * whole point of serving them.
 */
@Controller({ version: '1', path: 'agent-skill' })
export class AgentSkillController {
  /**
   * The default guide's listing, plus every guide.
   *
   * The top-level `name`/`files` are the shape the settings screen already
   * reads; `skills` is what a caller wanting all of them uses. Adding a second
   * guide should not break a client that only knew about the first.
   */
  @Get()
  list() {
    return {
      ...listSkill(DEFAULT_SKILL),
      skills: Object.keys(SKILLS).map((skill) => listSkill(skill)),
    };
  }

  @Get(':skill/:file')
  downloadFromSkill(
    @Param('skill') skill: string,
    @Param('file') file: string,
    @Res() response: Response,
  ) {
    this.send(skill, file, response);
  }

  /** The original, unprefixed route. Answers for the issues guide. */
  @Get(':file')
  download(@Param('file') file: string, @Res() response: Response) {
    this.send(DEFAULT_SKILL, file, response);
  }

  private send(skill: string, file: string, response: Response) {
    // Whitelisted by exact name rather than sanitised: the set of guides and
    // files this serves is fixed and known, so nothing user-supplied ever
    // reaches a path.
    if (!Object.hasOwn(SKILLS, skill)) {
      throw new NotFoundException(
        `No such guide. Available: ${Object.keys(SKILLS).join(', ')}.`,
      );
    }

    if (!Object.hasOwn(SKILLS[skill].files, file)) {
      throw new NotFoundException(
        `No such file. Available: ${Object.keys(SKILLS[skill].files).join(', ')}.`,
      );
    }

    const body = servedBody(skill, file);

    if (body === undefined) {
      throw new NotFoundException(
        'The guide is not present in this deployment.',
      );
    }

    response
      .type('text/markdown; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${file}"`);
    response.send(body);
  }
}
