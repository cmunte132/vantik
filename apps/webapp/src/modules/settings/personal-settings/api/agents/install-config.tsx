import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

import { CopyBlock } from '../copy-block';
import {
  type Harness,
  TOKEN_PLACEHOLDER,
  contextAppendCommand,
  harnessConfigs,
  skillsAddCommand,
} from './harnesses';

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

/** This instance as the browser sees it. The agent reaches the same origin. */
function appOrigin(): string {
  return typeof window !== 'undefined'
    ? window.location.origin
    : 'https://your-vantik-host';
}

export function InstallConfig({ token }: InstallConfigProps) {
  const origin = appOrigin();
  // The MCP endpoint sits behind the webapp's /api proxy.
  const url = `${origin}/api/v1/mcp`;
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

      <SkillInstall harness={active} origin={origin} />

      <HookInstall harness={active} />
    </div>
  );
}

/**
 * The optional second half of connecting an agent: the guides that tell it how
 * to use the tracker and the knowledge bank well.
 *
 * Installed like any other agent skill, with the skills CLI pointed at this
 * instance, which publishes them as a discovery index. The CLI knows where each
 * tool keeps its skills, so the tab only decides the `--agent` flag, and
 * `npx skills update` brings them in line after Vantik is upgraded.
 */
function SkillInstall({
  harness,
  origin,
}: {
  harness: Harness;
  origin: string;
}) {
  const { skill } = harness;

  return (
    <div className="border-t border-border pt-3 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm">Optional: the house style, as agent skills</p>
        <p className="text-sm text-muted-foreground">
          The config above is all your agent needs to read and file issues. Left
          to itself, though, an agent tends to file a long tail of one-line
          tickets, and to tell only the chat window what it learned. Three
          guides correct that: one for issues, one for the knowledge bank, and
          one for handing an issue to Vantik’s own agent. The command asks which
          to install, and whether for this project or for every project.
        </p>
      </div>

      <CopyBlock
        label={`Install for ${harness.label}`}
        value={skillsAddCommand(origin, skill.agent)}
      />

      <CopyBlock
        label={`Or keep the issues guide always in context, in ${skill.contextFile}`}
        value={contextAppendCommand(origin, skill.contextFile)}
      />
    </div>
  );
}

/**
 * The third, and the one that is checked rather than advised: hooks that brief
 * the agent when a session begins, name the pages of the knowledge bank that
 * match each prompt, and hold the agent at a stop once. The stop hook holds it
 * over an issue that went quiet, over work that has no issue, or over a long
 * stretch of work that recorded nothing in the knowledge bank.
 *
 * Offered after the skills, because they enforce what the skills explain; an
 * agent held at a stop without the guide still gets told what to do, but one
 * with the guide rarely needs holding.
 */
function HookInstall({ harness }: { harness: Harness }) {
  const { hooks } = harness;

  return (
    <div className="border-t border-border pt-3 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm">Optional: hooks that keep the tracker current</p>
        <p className="text-sm text-muted-foreground">
          A skill is advice. With these hooks, the first prompt of a session is
          told what the agent has in progress, and each prompt is told which
          pages of the knowledge bank match it. An agent about to stop is held
          once if an issue it has in progress has gone 20 minutes without an
          update from it, if it changed files with nothing in progress, or if it
          changed files ten times and recorded nothing it learned in the
          knowledge bank. The check runs on this server; the hooks write nothing
          to the tracker themselves.
        </p>
        <p className="text-sm text-muted-foreground">{hooks.intro}</p>
      </div>

      {hooks.blocks.map((block) => (
        <CopyBlock key={block.label} label={block.label} value={block.value} />
      ))}
    </div>
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
