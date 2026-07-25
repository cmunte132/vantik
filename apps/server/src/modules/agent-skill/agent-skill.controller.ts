import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';

/**
 * Serves the working-vantik-issues guide so it can be installed from the app
 * rather than found in a checkout.
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
  transform?: (body: string) => string;
}

const SERVED_FILES: Record<string, ServedFile> = {
  'SKILL.md': {
    description: 'Claude Code skill. Loads on demand when issue work comes up.',
  },
  'AGENTS.md': {
    description:
      'Portable snippet for runners that read an AGENTS.md. Always in context.',
    // Served stripped like the rest: this one is usually appended to an
    // AGENTS.md the reader already has, where a note telling them to paste the
    // section below is answering a question they just answered.
    transform: stripAuthorNote,
  },
  'CLAUDE.md': {
    description:
      'The same snippet for a Claude Code CLAUDE.md, for anyone who would rather keep it always in context than install the skill.',
    source: 'AGENTS.md',
    transform: stripAuthorNote,
  },
  'working-vantik-issues.mdc': {
    description:
      'Cursor project rule. Same guidance, in the format Cursor reads.',
    source: 'AGENTS.md',
    transform: toCursorRule,
  },
  'README.md': {
    description: 'Install instructions for every form.',
  },
};

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
function toCursorRule(body: string): string {
  return [
    '---',
    'description: How to file and work Vantik issues over MCP',
    'alwaysApply: true',
    '---',
    '',
    stripAuthorNote(body),
  ].join('\n');
}

/**
 * Where the guide sits. The image copies it next to the server; a dev server
 * run from the repo reads it out of the docs app, which is the one place it is
 * authored.
 */
const CANDIDATE_DIRS = [
  join(process.cwd(), 'apps/server/skills/working-vantik-issues'),
  join(process.cwd(), 'skills/working-vantik-issues'),
  join(process.cwd(), 'apps/docs/skills/working-vantik-issues'),
  join(process.cwd(), '../../apps/docs/skills/working-vantik-issues'),
];

/**
 * Every served body, read and transformed once.
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
  const dir = CANDIDATE_DIRS.find((candidate) => existsSync(candidate));

  if (!dir) {
    return bodies;
  }

  for (const [file, served] of Object.entries(SERVED_FILES)) {
    const path = join(dir, served.source ?? file);

    if (!existsSync(path)) {
      continue;
    }

    const body = readFileSync(path, 'utf8');
    bodies.set(file, served.transform ? served.transform(body) : body);
  }

  return bodies;
}

@Controller({ version: '1', path: 'agent-skill' })
export class AgentSkillController {
  @Get()
  list() {
    return {
      name: 'working-vantik-issues',
      files: Object.entries(SERVED_FILES)
        .filter(([file]) => BODIES.has(file))
        .map(([file, { description }]) => ({ file, description })),
    };
  }

  @Get(':file')
  download(@Param('file') file: string, @Res() response: Response) {
    // Whitelisted by exact name rather than sanitised: the set of files this
    // serves is fixed and known, so nothing user-supplied ever reaches a path.
    if (!Object.hasOwn(SERVED_FILES, file)) {
      throw new NotFoundException(
        `No such file. Available: ${Object.keys(SERVED_FILES).join(', ')}.`,
      );
    }

    const body = BODIES.get(file);

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
