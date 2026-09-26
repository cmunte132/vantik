import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The agent guides this server publishes, and every form each is served in.
 *
 * Shared by the two routes that hand them out: the Agent Skills discovery index
 * under `/.well-known/agent-skills`, which is how they are installed, and the
 * one-file-at-a-time `/v1/agent-skill`, which is how the always-in-context forms
 * are fetched. Both read the same bodies, loaded once below.
 */
interface ServedFile {
  description: string;
  /** The authored file this is served from, relative to `skills/`. */
  source: string;
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
 * Written once and shared, because both guides are authored the same way — an
 * agent skill plus a shorter always-in-context snippet — and the CLAUDE.md and
 * Cursor forms are *derived* rather than authored. Deriving them is what keeps
 * one piece of guidance from drifting into four slightly different pieces.
 *
 * The snippet lives outside the skill's own directory, which holds nothing but
 * SKILL.md: `npx skills add cmunte132/vantik` copies a skill's whole directory
 * into the user's project, so anything else there would land beside the skill.
 */
function servedFiles(skill: string): Record<string, ServedFile> {
  const alwaysInContext = `always-in-context/${skill}.md`;

  return {
    'SKILL.md': {
      description: 'Agent skill. Loads on demand when the work comes up.',
      source: `${skill}/SKILL.md`,
    },
    'AGENTS.md': {
      description:
        'Portable snippet for runners that read an AGENTS.md. Always in context.',
      source: alwaysInContext,
      // Served stripped like the rest: this one is usually appended to an
      // AGENTS.md the reader already has, where a note telling them to paste
      // the section below is answering a question they just answered.
      transform: (_skill, body) => stripAuthorNote(body),
    },
    'CLAUDE.md': {
      description:
        'The same snippet for a Claude Code CLAUDE.md, for anyone who would rather keep it always in context than install the skill.',
      source: alwaysInContext,
      transform: (_skill, body) => stripAuthorNote(body),
    },
    [`${skill}.mdc`]: {
      description:
        'Cursor project rule. Same guidance, in the format Cursor reads.',
      source: alwaysInContext,
      transform: toCursorRule,
    },
    'README.md': {
      description: 'What the guides are, and every way to install them.',
      // One README for both guides, at the top of `skills/`.
      source: 'README.md',
    },
  };
}

export const SKILLS: Record<string, ServedSkill> = {
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
  'delegating-vantik-work': {
    description:
      'How to hand an issue to Vantik’s own agent: when it is ready, what the review loop delivers, how to read a run.',
    ruleDescription: 'How to delegate Vantik issues to its hosted agent',
    files: servedFiles('delegating-vantik-work'),
  },
};

/** The guide the unprefixed routes answer for, kept as it was before. */
export const DEFAULT_SKILL = 'working-vantik-issues';

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
 * Where the guides sit: `skills/` at the root of the repository, the one place
 * they are authored and where `npx skills add cmunte132/vantik` finds them. The
 * image copies that directory next to the server, whose entrypoint runs from
 * `apps/server`, as a dev server does — two levels below the root.
 */
function candidateRoots(): string[] {
  return [
    join(process.cwd(), 'skills'),
    join(process.cwd(), '../../skills'),
    join(process.cwd(), 'apps/server/skills'),
  ];
}

/**
 * Every served body, read and transformed once, keyed `skill/file`.
 *
 * These routes are deliberately unauthenticated, and they were doing the work
 * per request: up to four `existsSync` calls to find the directory, twenty for a
 * listing, and a synchronous `readFileSync` that parks the whole event loop.
 * That is a lot to hand an anonymous caller with a loop. The files ship inside
 * the image and are identical for every workspace, so there is nothing to
 * re-read — a miss here means the guide is not in this deployment at all.
 */
const BODIES: Map<string, string> = loadServedBodies();

function loadServedBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const roots = candidateRoots();

  for (const [skill, served] of Object.entries(SKILLS)) {
    for (const [file, servedFile] of Object.entries(served.files)) {
      const path = roots
        .map((root) => join(root, servedFile.source))
        .find((candidate) => existsSync(candidate));

      if (!path) {
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

/**
 * One served file, or `undefined` when this deployment does not have it.
 *
 * Callers check the guide and file names against `SKILLS` first: this is a map
 * lookup, but the names reach it from a URL.
 */
export function servedBody(skill: string, file: string): string | undefined {
  return BODIES.get(`${skill}/${file}`);
}

export function listSkill(skill: string) {
  return {
    name: skill,
    description: SKILLS[skill].description,
    files: Object.entries(SKILLS[skill].files)
      .filter(([file]) => BODIES.has(`${skill}/${file}`))
      .map(([file, { description }]) => ({ file, description })),
  };
}
