import { RiDownloadLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

import { CopyBlock } from '../copy-block';
import { type Harness, TOKEN_PLACEHOLDER, harnessConfigs } from './harnesses';

/**
 * Ready-to-paste connection config, one tab per agent harness. It only ever
 * formats the same endpoint + token, never a second source of truth.
 *
 * Rendered once on the page, and the token is what changes rather than the
 * instructions. Read before anything has been created it shows the steps with a
 * placeholder where the token goes — worth reading precisely because you are
 * deciding whether to set an agent up at all — and the moment one is minted the
 * same blocks carry the real value. Which also means the tab you were reading
 * is still the tab you get, filled in.
 *
 * Revealing the secret is not this component's job: the create form does that,
 * where the "copy it now, it is shown once" warning belongs.
 */
interface InstallConfigProps {
  /** The real token. Omit for the instructions, which use a placeholder. */
  token?: string;
}

/** The MCP endpoint as the browser sees it — same origin, behind the /api proxy. */
function mcpUrl(): string {
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://your-vantik-host';
  return `${origin}/api/v1/mcp`;
}

export function InstallConfig({ token }: InstallConfigProps) {
  const url = mcpUrl();
  const harnesses = harnessConfigs(url, token ?? TOKEN_PLACEHOLDER);
  const [activeId, setActiveId] = React.useState(harnesses[0].id);
  const active =
    harnesses.find((harness) => harness.id === activeId) ?? harnesses[0];

  return (
    <div className="flex flex-col gap-4">
      <HarnessTabs
        harnesses={harnesses}
        activeId={active.id}
        onSelect={setActiveId}
      />

      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{active.intro}</p>
        {active.blocks.map((block) => (
          <CopyBlock
            key={block.label}
            label={block.label}
            value={block.value}
          />
        ))}
      </div>

      <SkillInstall harness={active} />
    </div>
  );
}

/** Where the server serves the guide from, as the browser sees it. */
function skillUrl(file: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/v1/agent-skill/${file}`;
}

/**
 * The optional second half of connecting an agent: the guide that tells it how
 * to file issues well.
 *
 * Follows the harness tab, because the tools do not agree on any of this — a
 * Claude Code skill in `.claude/skills/`, an `AGENTS.md` in the project root, a
 * `.mdc` rule under `.cursor/rules/`. Offering the same two files to everyone
 * would leave each person working out which one their tool reads and where to
 * put it, which is the digging this was meant to remove.
 */
function SkillInstall({ harness }: { harness: Harness }) {
  const { skill } = harness;

  return (
    <div className="border-t border-border pt-3 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm">Optional: house style for filing issues</p>
        <p className="text-sm text-muted-foreground">
          The config above is all your agent needs to read and file issues. Left
          to itself, though, an agent tends to file a long tail of one-line
          tickets. This guide tells it to file fewer, bigger issues, and to add
          a note to an existing issue rather than open a near-duplicate.
        </p>
      </div>

      <CopyBlock
        label={`Install for ${harness.label} — ${skill.target}`}
        value={skill.install(skillUrl(skill.file))}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Or download:</span>
        <DownloadButton file={skill.file} />
        {skill.alternative && (
          <>
            <DownloadButton file={skill.alternative.file} />
            <span className="text-sm text-muted-foreground">
              → {skill.alternative.target}. {skill.alternative.note}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function DownloadButton({ file }: { file: string }) {
  return (
    <Button variant="secondary" size="sm" asChild>
      <a href={skillUrl(file)} download={file}>
        <RiDownloadLine size={14} className="mr-1" />
        {file}
      </a>
    </Button>
  );
}

function HarnessTabs({
  harnesses,
  activeId,
  onSelect,
}: {
  harnesses: Harness[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-2">
      {harnesses.map((harness) => (
        <button
          key={harness.id}
          type="button"
          onClick={() => onSelect(harness.id)}
          className={cn(
            'rounded px-3 py-1 text-sm',
            harness.id === activeId
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-grayAlpha-100',
          )}
        >
          {harness.label}
        </button>
      ))}
    </div>
  );
}
