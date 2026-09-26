import { createHash } from 'crypto';

import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';

import { SKILLS, servedBody } from './agent-skill.catalogue';

/**
 * The agent guides, published the way agent skills are published anywhere else.
 *
 * `/v1/agent-skill` hands out one file at a time, and installing from it meant
 * the Agents screen printing a different curl-into-place command for every tool
 * — each keeps its skills in its own directory — with no way to update what had
 * been installed short of running it again. This serves the Agent Skills
 * discovery index (https://agentskills.io, schema 0.2.0) instead, so the install
 * is the same one-liner as for any other skill:
 *
 *   npx skills add https://your-vantik-host
 *
 * The skills CLI then knows where each agent wants the file, offers both guides
 * or either, and `npx skills update` compares against the digests here. Served
 * by the instance rather than fetched from a git repository on purpose: the
 * guides name this server's MCP tools, so the copy that matches is the one this
 * deployment shipped with.
 *
 * Unauthenticated for the same reason as `/v1/agent-skill`: fixed documents
 * from the image, identical for every workspace.
 */
const DISCOVERY_SCHEMA =
  'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

/**
 * The files change only when the image does. Short enough that a deploy is
 * picked up promptly, long enough to spare the server a client that re-fetches
 * the index for every skill it resolves.
 */
const CACHE_CONTROL = 'public, max-age=300';

interface DiscoveryEntry {
  name: string;
  type: 'skill-md';
  description: string;
  url: string;
  digest: string;
}

/**
 * The `description` from a SKILL.md's frontmatter, on one line.
 *
 * The index should carry the description the skill itself does. Both guides
 * write theirs as a folded block (`>-`), so this reads that form and the plain
 * one-line form — not YAML in general, which nothing here needs.
 */
export function frontmatterDescription(body: string): string | undefined {
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---/)?.[1];

  if (!frontmatter) {
    return undefined;
  }

  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.startsWith('description:'));

  if (start === -1) {
    return undefined;
  }

  const inline = lines[start].slice('description:'.length).trim();

  if (inline && !/^[>|][+-]?$/.test(inline)) {
    return inline;
  }

  const block: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) {
      break;
    }

    block.push(line.trim());
  }

  return block.join(' ') || undefined;
}

/**
 * Built once, like the bodies it describes. A guide missing from this
 * deployment is left out rather than listed with nothing behind it.
 */
const INDEX = {
  $schema: DISCOVERY_SCHEMA,
  skills: Object.keys(SKILLS).flatMap((skill): DiscoveryEntry[] => {
    const body = servedBody(skill, 'SKILL.md');

    if (body === undefined) {
      return [];
    }

    return [
      {
        name: skill,
        type: 'skill-md',
        description: frontmatterDescription(body) ?? SKILLS[skill].description,
        // Relative, so it resolves against wherever the index was fetched from:
        // the bare origin through the webapp's rewrite, `/api` through its
        // proxy, or the server directly. The server cannot tell which.
        url: `${skill}/SKILL.md`,
        // Of the exact bytes the route below sends; clients refuse a mismatch.
        digest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      },
    ];
  }),
};

@Controller('.well-known/agent-skills')
export class WellKnownSkillsController {
  @Get('index.json')
  @Header('Cache-Control', CACHE_CONTROL)
  @Header('Access-Control-Allow-Origin', '*')
  index() {
    return INDEX;
  }

  @Get(':skill/SKILL.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Cache-Control', CACHE_CONTROL)
  @Header('Access-Control-Allow-Origin', '*')
  skill(@Param('skill') skill: string): string {
    // Whitelisted by exact name, as in `/v1/agent-skill`: nothing from the URL
    // reaches a path.
    const body = Object.hasOwn(SKILLS, skill)
      ? servedBody(skill, 'SKILL.md')
      : undefined;

    if (body === undefined) {
      throw new NotFoundException(
        `No such skill. Available: ${INDEX.skills.map((entry) => entry.name).join(', ')}.`,
      );
    }

    return body;
  }
}
