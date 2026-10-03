/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentRunCleanup } from '@vantikhq/types';

import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiGitPullRequestLine,
  RiLoader4Line,
  RiStopCircleLine,
} from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import React from 'react';

import { describe as describeCleanup } from './clean-up-run';
import { Counts } from './run-activity';
import {
  type FeedItem,
  type FileChange,
  type Stage,
  basename,
  clock,
  doing,
  pullNumber,
} from './run-feed';
import { formatCost, shownStatus, whereTheWorkWent } from './run-vocabulary';

/**
 * The five stages of a run, as one bar each.
 *
 * Green is done, blue is in flight, red is where a run stopped. A stage the
 * run never needed — a review that is switched off — keeps an empty track, so
 * the five always line up with each other from run to run.
 */
export const Stepper = ({ stages }: { stages: Stage[] }) => (
  <ol aria-label="Progress" className="mt-1 grid grid-cols-5 gap-1.5">
    {stages.map((stage) => (
      <li key={stage.label} className="flex min-w-0 flex-col gap-1.5">
        <span className="relative h-1 overflow-hidden rounded-full bg-grayAlpha-100">
          <span
            className={cn(
              'absolute inset-y-0 left-0 rounded-full',
              stage.state === 'done' && 'w-full bg-success',
              stage.state === 'fail' && 'w-full bg-destructive',
              stage.state === 'now' && 'w-3/5 animate-pulse bg-primary',
              (stage.state === 'todo' || stage.state === 'skipped') && 'w-0',
            )}
          />
        </span>
        <span className="flex justify-between gap-1.5 text-sm">
          <span
            className={cn(
              'truncate',
              stage.state === 'todo' || stage.state === 'skipped'
                ? 'text-muted-foreground'
                : 'font-medium',
              stage.state === 'fail' && 'text-destructive',
            )}
          >
            {stage.label}
          </span>
          <span className="shrink-0 font-mono text-muted-foreground">
            {stage.state === 'skipped'
              ? 'skipped'
              : stage.ms
                ? clock(stage.ms)
                : ''}
          </span>
        </span>
      </li>
    ))}
  </ol>
);

/**
 * What the agent is doing right now.
 *
 * The same row as the last one in the feed, drawn large enough to watch. Pi
 * reports a step when it starts, so this is the step that has started and not
 * yet been followed by another.
 */
export const NowCard = ({ item, now }: { item: FeedItem; now: number }) => {
  const step = item.type === 'step' ? item.step : null;
  const title =
    item.type === 'setup'
      ? (item.lines[item.lines.length - 1] ?? 'Setting up')
      : doing(item.step);
  const command =
    step && (step.kind === 'bash' || step.kind === 'test')
      ? step.command
      : undefined;
  const target =
    step && ['read', 'write', 'search'].includes(step.kind ?? '')
      ? step.targets[step.targets.length - 1]
      : undefined;

  return (
    <div className="overflow-hidden rounded-xl border border-primary/45 bg-background-3 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_6px_20px_oklch(60%_0.13_240/0.1)]">
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5">
        <RiLoader4Line
          size={18}
          className="shrink-0 animate-spin text-primary"
        />
        <div className="flex min-w-0 grow flex-col">
          <span className="text-xs font-medium tracking-wider text-primary uppercase">
            Now
          </span>
          <span className="truncate text-[14px] font-semibold">{title}</span>
        </div>
        {item.at && (
          <span className="shrink-0 font-mono text-muted-foreground">
            {clock(now - Date.parse(item.at))}
          </span>
        )}
      </div>

      {(command || target) && (
        <div className="mx-4 mb-3.5 truncate rounded-md bg-grayAlpha-100 px-2.5 py-1.5 font-mono text-sm">
          {command && <span className="text-muted-foreground">$ </span>}
          {command ?? target}
          <span className="ml-0.5 animate-pulse">▍</span>
        </div>
      )}

      {step?.kind === 'note' && (
        <p className="mx-4 mb-3.5 line-clamp-2 text-muted-foreground">
          {step.text}
        </p>
      )}
    </div>
  );
};

type Tone = 'success' | 'warning' | 'destructive' | 'muted';

/**
 * How the run ended, and where the work is.
 *
 * The first thing a reader of a finished run wants, so it sits where the Now
 * card sat while the run was live: the verdict, the agent's own summary, and
 * the one button that takes them to the work.
 */
export const OutcomeCard = ({
  run,
  failure,
  feed,
  cleanedUpBy,
}: {
  run: any;
  failure?: { what: string; next: string };
  feed: FeedItem[];
  /** Who cleaned up after the run, when somebody did and is known. */
  cleanedUpBy?: string;
}) => {
  const where = whereTheWorkWent(run.result ?? {});
  const { tone, heading } = verdict(run, failure);
  const pr = pullNumber(run.result?.prUrl);
  const facts = outcomeFacts(feed);
  const cleanup: AgentRunCleanup | undefined = run.result?.cleanedUp;
  // What the cleanup removed is no longer a place to go: a closed pull request
  // is still worth a look, but not as the card's call to action, and a deleted
  // branch is nothing to copy.
  const prOpen = !cleanup || cleanup.pullRequest === 'merged';
  const branchLeft =
    !cleanup || !['deleted', 'already_gone'].includes(cleanup.branch);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-background-3 px-[18px] pt-[18px] pb-4',
        tone === 'success' && 'border-success/50',
        tone === 'warning' && 'border-warning/50',
        tone === 'destructive' && 'border-destructive/40',
        tone === 'muted' && 'border-border',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-full text-white',
            tone === 'success' && 'bg-success',
            tone === 'warning' && 'bg-warning',
            tone === 'destructive' && 'bg-destructive',
            tone === 'muted' && 'bg-grayAlpha-500',
          )}
        >
          {tone === 'success' ? (
            <RiCheckLine size={15} />
          ) : tone === 'warning' ? (
            <RiErrorWarningLine size={15} />
          ) : tone === 'destructive' ? (
            <RiCloseLine size={15} />
          ) : (
            <RiStopCircleLine size={15} />
          )}
        </span>
        <span className="text-md font-semibold">{heading}</span>
      </div>

      {/* The run's own message names the cause; the category's remedy is a
          guess at it, so it shows only when the run gave no message. */}
      {run.error ? (
        <p className="text-muted-foreground">{run.error}</p>
      ) : (
        failure && <p className="text-muted-foreground">{failure.next}</p>
      )}

      {cleanup && (
        <p className="text-muted-foreground">
          {shownStatus(run) === 'REJECTED' ? 'Rejected' : 'Cleaned up'}
          {cleanedUpBy ? ` by ${cleanedUpBy}` : ''}{' '}
          {new Date(cleanup.at).toLocaleString()}. {describeCleanup(cleanup)}
        </p>
      )}

      {run.summary && <Summary text={run.summary} />}

      {(where || facts) && (
        <div className="flex flex-wrap items-center gap-2">
          {where?.kind === 'pull_request' && (
            <Button variant={prOpen ? 'default' : 'secondary'} asChild>
              <a href={where.value} target="_blank" rel="noreferrer">
                <RiGitPullRequestLine className="mr-1.5" size={15} />
                {!prOpen
                  ? pr
                    ? `Closed pull request #${pr}`
                    : 'The closed pull request'
                  : pr
                    ? `Review pull request #${pr}`
                    : 'Review the pull request'}
              </a>
            </Button>
          )}

          {where?.kind === 'worktree' && (
            <Button
              variant="secondary"
              onClick={() =>
                navigator.clipboard?.writeText(`cd ${where.value}`)
              }
            >
              Copy cd path
            </Button>
          )}

          {/* Beside the pull request rather than instead of it: a reviewer
              opens the PR, and somebody pulling the work locally wants the
              branch. */}
          {run.result?.branch && branchLeft && where?.kind !== 'worktree' && (
            <Button
              variant="secondary"
              onClick={() => navigator.clipboard?.writeText(run.result.branch)}
            >
              Copy branch
            </Button>
          )}

          <span className="grow" />

          {facts && <span className="text-muted-foreground">{facts}</span>}
        </div>
      )}
    </div>
  );
};

/** The agent's closing report, cut to its start until somebody asks. */
const Summary = ({ text }: { text: string }) => {
  const long = text.length > 480 || text.split('\n').length > 6;
  const [open, setOpen] = React.useState(false);

  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          'text-[14px] leading-normal whitespace-pre-wrap',
          long && !open && 'line-clamp-6',
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <RiArrowDownSLine size={14} />
          ) : (
            <RiArrowRightSLine size={14} />
          )}
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
};

/**
 * How the run ended, in one line.
 *
 * Written rather than composed from a status enum, because the sentence a
 * reader needs is not the same for a run that produced a pull request and one
 * that stopped at a ceiling.
 */
function verdict(
  run: any,
  failure?: { what: string },
): { tone: Tone; heading: string } {
  if (failure) {
    return {
      tone: 'destructive',
      heading: `Could not finish: ${failure.what}`,
    };
  }

  switch (run.status) {
    case 'SUCCEEDED':
      return {
        tone: 'success',
        heading: run.result?.prUrl
          ? 'Finished and opened a pull request'
          : 'Finished the work',
      };
    case 'NEEDS_REVIEW':
      if (run.result?.cleanedUp) {
        return { tone: 'muted', heading: 'Rejected: the work was not kept' };
      }
      return {
        tone: 'warning',
        heading: 'Finished, but somebody has to judge whether it is right',
      };
    case 'CANCELED':
      return { tone: 'muted', heading: 'Stopped before it finished' };
    default:
      return { tone: 'destructive', heading: 'Could not finish this run' };
  }
}

/** The last test count and the reviewer's last word, from the feed. */
function outcomeFacts(feed: FeedItem[]): string {
  let tests = '';
  let review = '';

  for (const item of feed) {
    if (item.type !== 'step') {
      continue;
    }
    const { step } = item;

    if (step.kind === 'test' && step.passed != null) {
      tests = step.failedCount
        ? `${step.failedCount} of ${step.passed + step.failedCount} tests fail`
        : `${step.passed} tests pass`;
    }
    if (!step.kind && /^The reviewer /.test(step.message)) {
      review = `the reviewer ${step.message.slice('The reviewer '.length)}`;
    }
  }

  return [tests, review].filter(Boolean).join(' · ');
}

/** One card of the right-hand rail. */
export const RailCard = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-background-3 px-4 py-3.5">
    <div className="flex items-center">
      <h3 className="grow font-semibold">{title}</h3>
      {aside}
    </div>
    {children}
  </div>
);

export const DefinitionOfDone = ({ items }: { items: any[] }) => {
  const done = items.filter((item) => item.completed).length;

  return (
    <RailCard
      title="Definition of Done"
      aside={
        <span className="font-mono text-sm text-muted-foreground">
          {done} / {items.length}
        </span>
      }
    >
      {items.map((item) => (
        <div key={item.id} className="flex gap-2.5">
          <span
            className={cn(
              'mt-0.5 grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px] text-white',
              item.completed ? 'border-success bg-success' : 'border-border',
            )}
          >
            {item.completed && <RiCheckLine size={10} />}
          </span>
          <span
            className={cn(
              item.completed && 'text-muted-foreground line-through',
            )}
          >
            {item.body}
          </span>
        </div>
      ))}
    </RailCard>
  );
};

export const Changes = ({ files }: { files: FileChange[] }) => {
  const total = (key: 'added' | 'removed') =>
    files.some((file) => file[key] != null)
      ? files.reduce((sum, file) => sum + (file[key] ?? 0), 0)
      : undefined;

  return (
    <RailCard
      title="Changes"
      aside={<Counts added={total('added')} removed={total('removed')} />}
    >
      {files.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 font-mono text-sm"
          title={file.path}
        >
          <span className="min-w-0 grow truncate">{basename(file.path)}</span>
          <Counts added={file.added} removed={file.removed} />
        </div>
      ))}
    </RailCard>
  );
};

export const RunFacts = ({
  facts,
}: {
  facts: Array<{ label: string; value: string; mono?: boolean }>;
}) => (
  <RailCard title="This run">
    {facts.map((fact) => (
      <div key={fact.label} className="flex gap-2.5">
        <span className="w-[74px] shrink-0 text-muted-foreground">
          {fact.label}
        </span>
        <span
          className={cn('min-w-0 truncate', fact.mono && 'font-mono text-sm')}
          title={fact.value}
        >
          {fact.value}
        </span>
      </div>
    ))}
  </RailCard>
);

/**
 * What the run has spent, against what it may spend.
 *
 * The run writes its spend while it works, so this moves as the agent does.
 * The ceiling is checked between passes, not inside one, so a pass that starts
 * under it can end over it; the note says so rather than letting the bar
 * promise a hard stop.
 */
export const SpendCard = ({
  costUsd,
  budgetUsd,
  turns,
  passes,
  live,
  agentTotal,
}: {
  costUsd: number | null;
  budgetUsd: number;
  turns?: number;
  passes?: number;
  live: boolean;
  /** What this issue's agent has spent over all its attempts, when more than one. */
  agentTotal?: { costUsd: number; runs: number };
}) => {
  const spent = costUsd ?? 0;
  const share = budgetUsd > 0 ? spent / budgetUsd : 0;

  return (
    <RailCard
      title="Spend"
      aside={
        live ? (
          <span className="text-sm text-muted-foreground">live</span>
        ) : undefined
      }
    >
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-xl font-semibold tabular-nums">
          {costUsd == null ? '—' : formatCost(spent)}
        </span>
        <span className="text-muted-foreground">
          of {formatCost(budgetUsd)}
        </span>
      </div>

      <span
        className="relative h-1.5 overflow-hidden rounded-full bg-grayAlpha-100"
        role="meter"
        aria-label="Spend against the budget"
        aria-valuemin={0}
        aria-valuemax={budgetUsd}
        aria-valuenow={spent}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
            share >= 1
              ? 'bg-destructive'
              : share >= 0.8
                ? 'bg-warning'
                : 'bg-primary',
          )}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
      </span>

      {(turns != null || passes != null) && (
        <div className="flex gap-4 text-muted-foreground">
          {turns != null && (
            <span>
              <span className="text-foreground tabular-nums">{turns}</span> turn
              {turns === 1 ? '' : 's'}
            </span>
          )}
          {passes != null && (
            <span>
              <span className="text-foreground tabular-nums">{passes}</span>{' '}
              pass{passes === 1 ? '' : 'es'}
            </span>
          )}
        </div>
      )}

      {agentTotal && (
        <p className="text-muted-foreground">
          This agent has spent{' '}
          <span className="text-foreground tabular-nums">
            {formatCost(agentTotal.costUsd)}
          </span>{' '}
          on this issue over {agentTotal.runs} runs.
        </p>
      )}

      {live && (
        <p className="text-sm text-muted-foreground">
          The budget is checked between passes, so a pass can end a little over
          it.
        </p>
      )}
    </RailCard>
  );
};
