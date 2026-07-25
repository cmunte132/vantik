import { RiCheckLine, RiClipboardLine, RiDownloadLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import copy from 'copy-to-clipboard';
import * as React from 'react';

import { type Harness, TOKEN_PLACEHOLDER, harnessConfigs } from './harnesses';

/**
 * Turns an agent token into ready-to-paste connection config, one tab per agent
 * harness. Used both right after provisioning (token present, shown once) and in
 * the connect panel as a live preview (token still a placeholder). It only ever
 * formats the same endpoint + token, never a second source of truth.
 */
interface InstallConfigProps {
  /** The real token, once minted. Omit to preview with a placeholder. */
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

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = () => {
    copy(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Button variant="ghost" size="xs" onClick={onCopy}>
          {copied ? (
            <RiCheckLine size={14} className="mr-1" />
          ) : (
            <RiClipboardLine size={14} className="mr-1" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-background-3 rounded p-3 text-xs overflow-x-auto whitespace-pre">
        {value}
      </pre>
    </div>
  );
}

export function InstallConfig({ token }: InstallConfigProps) {
  const url = mcpUrl();
  const hasToken = Boolean(token);
  const harnesses = harnessConfigs(url, token ?? TOKEN_PLACEHOLDER);
  const [activeId, setActiveId] = React.useState(harnesses[0].id);
  const active =
    harnesses.find((harness) => harness.id === activeId) ?? harnesses[0];

  return (
    <div className="flex flex-col gap-4">
      {hasToken && (
        <div className="flex flex-col gap-1">
          <p className="text-sm">
            Copy the token now — it is shown once and cannot be retrieved again.
          </p>
          <CopyBlock label="Token" value={token as string} />
        </div>
      )}

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
