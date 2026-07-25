import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';

/**
 * Serves the agent guides so they can be installed from the app rather than
 * found in a checkout.
 *
 * The Agents screen used to end by telling people the guide lived at a path in
 * the Vantik repo, which is only useful to someone who has the repo open and is
 * willing to go looking. Serving the files means the settings screen can offer
 * a download button and a one-line install command instead.
 *
 * Deliberately unauthenticated: these are fixed documents shipped in the image,
 * identical for every workspace and containing nothing about anyone's data.
 * Requiring a token would also break the curl-into-place install, which is the
 * whole point of serving them.
 */
interface ServedFile {
  description: string;
  /** The authored file this is served from, when the name differs. */
  source?: string;
  /** Rewrites the authored text into another tool's format. */
  transform?: (skill: string, body: string) => string;
}

interface ServedSkill {
  description: string;
  /** Frontmatter description for the derived Cursor rule. */
  ruleDescription: string;
  files: Record<string, ServedFile>;
}

/**
 * The files each guide is served in.
 *
 * Written once and shared, because both guides are authored the same way — a
 * Claude Code skill plus a portable snippet — and the CLAUDE.md and Cursor
 * forms are *derived* rather than authored. Deriving them is what keeps one
 * piece of guidance from drifting into four slightly different pieces.
 */
function servedFiles(skill: string): Record<string, ServedFile> {
  return {
    'SKILL.md': {
      description: 'Claude Code skill. Loads on demand when the work comes up.',
    },
    'AGENTS.md': {
      description:
        'Portable snippet for runners that read an AGENTS.md. Always in context.',
      // Served stripped like the rest: this one is usually appended to an
      // AGENTS.md the reader already has, where a note telling them to paste
      // the section below is answering a question they just answered.
      transform: (_skill, body) => stripAuthorNote(body),
    },
    'CLAUDE.md': {
      description:
        'The same snippet for a Claude Code CLAUDE.md, for anyone who would rather keep it always in context than install the skill.',
      source: 'AGENTS.md',
      transform: (_skill, body) => stripAuthorNote(body),
    },
    [`${skill}.mdc`]: {
      description:
        'Cursor project rule. Same guidance, in the format Cursor reads.',
      source: 'AGENTS.md',
      transform: toCursorRule,
    },
    'README.md': {
      description: 'Install instructions for every form.',
    },
  };
}

const SKILLS: Record<string, ServedSkill> = {
  'working-vantik-issues': {
    description: 'How to file and work Vantik issues over MCP.',
    ruleDescription: 'How to file and work Vantik issues over MCP',
    files: servedFiles('working-vantik-issues'),
  },
  'working-vantik-knowledge': {
    description:
      'How to use the Vantik knowledge bank: load context, remember one fact at a time, supersede rather than contradict.',
    ruleDescription: 'How to use the Vantik knowledge bank over MCP',
    files: servedFiles('working-vantik-knowledge'),
  },
};

/** The guide the unprefixed routes answer for, kept as it was before. */
const DEFAULT_SKILL = 'working-vantik-issues';

/**
 * Drops the comment at the top of AGENTS.md, which explains to a human which
 * form to install. Once we are handing someone the form they picked, that note
 * is answering a question they have already answered.
 */
function stripAuthorNote(body: string): string {
  return body.replace(/^<!--[\s\S]*?-->\s*/, '').trimStart();
}

/**
 * The same snippet as a Cursor project rule.
 *
 * Cursor reads rules from `.cursor/rules/*.mdc` with a frontmatter block, so
 * handing someone a bare AGENTS.md means doing that conversion by hand. Deriving
 * it here keeps the guidance authored in exactly one place: same body, with the
 * note-to-humans replaced by the frontmatter Cursor wants.
 */
function toCursorRule(skill: string, body: string): string {
  return [
    '---',
    `description: ${SKILLS[skill]?.ruleDescription ?? skill}`,
    'alwaysApply: true',
    '---',
    '',
    stripAuthorNote(body),
  ].join('\n');
}

/**
 * Where the guides sit. The image copies them next to the server; a dev server
 * run from the repo reads them out of the docs app, which is the one place they
 * are authored.
 */
function candidateDirs(skill: string): string[] {
  return [
    join(process.cwd(), 'apps/server/skills', skill),
    join(process.cwd(), 'skills', skill),
    join(process.cwd(), 'apps/docs/skills', skill),
    join(process.cwd(), '../../apps/docs/skills', skill),
  ];
}

/**
 * Every served body, read and transformed once, keyed `skill/file`.
 *
 * This route is deliberately unauthenticated, and it was doing the work per
 * request: up to four `existsSync` calls to find the directory, twenty for a
 * listing, and a synchronous `readFileSync` that parks the whole event loop.
 * That is a lot to hand an anonymous caller with a loop. The files ship inside
 * the image and are identical for every workspace, so there is nothing to
 * re-read — a miss here means the guide is not in this deployment at all.
 */
const BODIES: Map<string, string> = loadServedBodies();

function loadServedBodies(): Map<string, string> {
  const bodies = new Map<string, string>();

  for (const [skill, served] of Object.entries(SKILLS)) {
    const dir = candidateDirs(skill).find((candidate) => existsSync(candidate));

    if (!dir) {
      continue;
    }

    for (const [file, servedFile] of Object.entries(served.files)) {
      const path = join(dir, servedFile.source ?? file);

      if (!existsSync(path)) {
        continue;
      }

      const body = readFileSync(path, 'utf8');
      bodies.set(
        `${skill}/${file}`,
        servedFile.transform ? servedFile.transform(skill, body) : body,
      );
    }
  }

  return bodies;
}

function listSkill(skill: string) {
  return {
    name: skill,
    description: SKILLS[skill].description,
    files: Object.entries(SKILLS[skill].files)
      .filter(([file]) => BODIES.has(`${skill}/${file}`))
      .map(([file, { description }]) => ({ file, description })),
  };
}

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

    const body = BODIES.get(`${skill}/${file}`);

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
