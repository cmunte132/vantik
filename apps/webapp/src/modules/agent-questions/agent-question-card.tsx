/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentQuestionAnswer, AgentQuestionItem } from '@vantikhq/types';

import { RiCheckLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { Link, useRouter } from 'common/router';
import { workspaceHref } from 'common/workspace-href';

import { useAnswerAgentQuestionMutation } from 'services/agent-questions';

import { useContextStore } from 'store/global-context-provider';

import {
  acceptsOther,
  chosenText,
  closedLine,
  hasOptions,
  isComplete,
  placeOf,
  toAnswers,
  waitLine,
  type QuestionDraft,
} from './agent-question-text';

/** Re-renders a component every `ms`, so a countdown moves on its own. */
function useNow(ms: number, active: boolean) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), ms);

    return () => clearInterval(timer);
  }, [ms, active]);

  return now;
}

interface Props {
  questionId: string;
  /** Hide the issue link, where the surrounding page is the issue. */
  hideIssue?: boolean;
  className?: string;
}

/**
 * One question that an agent asked a person.
 *
 * The same card serves the Needs you inbox and the run view, and it does not
 * care where the run happens: a hosted Pi run and a local omp run write the
 * same record. While the question is open it is a form. Afterwards it says
 * what was chosen, or that nobody answered and the agent went on alone.
 */
export const AgentQuestionCard = observer(
  ({ questionId, hideIssue, className }: Props) => {
    const {
      agentQuestionsStore,
      agentRunsStore,
      agentSessionsStore,
      issuesStore,
      teamsStore,
    } = useContextStore();
    const {
      query: { workspaceSlug },
    } = useRouter();

    const question: any = agentQuestionsStore.getQuestionById(questionId);
    const open = question?.status === 'OPEN';
    const now = useNow(30000, open);

    if (!question) {
      return null;
    }

    const items = (question.questions ?? []) as AgentQuestionItem[];
    const answers = (question.answers ?? []) as AgentQuestionAnswer[];
    const run: any = question.agentRunId
      ? agentRunsStore.getRunById(question.agentRunId)
      : undefined;
    const session: any = question.agentSessionId
      ? agentSessionsStore.getSessionById(question.agentSessionId)
      : undefined;
    const issue: any = issuesStore.getIssueById(question.issueId);
    const team: any = issue && teamsStore.getTeamWithId(issue.teamId);
    const key = team && issue ? `${team.identifier}-${issue.number}` : '';
    const place = placeOf(
      run?.executor ?? (session?.location === 'local' ? 'local' : undefined),
      session?.harness ?? run?.config?.harness,
    );

    return (
      <div
        className={cn(
          'flex flex-col gap-3 rounded-[10px] border border-grayAlpha-100 bg-background-3 p-3.5',
          className,
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          {!hideIssue && key && (
            <Link
              href={workspaceHref(workspaceSlug, 'issue', key)}
              className="font-medium text-foreground hover:underline"
            >
              {key}
              {issue?.title ? ` ${issue.title}` : ''}
            </Link>
          )}
          <span>Asked from {place}</span>
          <span className="ml-auto">
            {open
              ? waitLine(question.expiresAt, now)
              : closedLine(question.status)}
          </span>
        </div>

        {open ? (
          <QuestionForm question={question} items={items} />
        ) : (
          <ol className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">{item.prompt}</span>
                {question.status === 'ANSWERED' && (
                  <span className="flex items-center gap-1 font-medium">
                    <RiCheckLine size={14} className="text-success" />
                    {chosenText(answers.find((each) => each.id === item.id))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  },
);

const QuestionForm = observer(
  ({ question, items }: { question: any; items: AgentQuestionItem[] }) => {
    const { agentQuestionsStore } = useContextStore();
    const [drafts, setDrafts] = React.useState<
      Record<string, QuestionDraft | undefined>
    >({});
    const [error, setError] = React.useState<string | null>(null);

    const { mutate: answer, isPending } = useAnswerAgentQuestionMutation({
      onMutate: () => setError(null),
      // The reply is the updated row, so the card flips at once instead of
      // waiting for the sync log.
      onSuccess: (row) => {
        agentQuestionsStore.update(
          { ...question, ...row, questions: question.questions },
          question.id,
        );
      },
      // A 409 means somebody else answered first, or time ran out. The server
      // says which, and the sync log brings the current state.
      onError: setError,
    });

    const draftOf = (id: string): QuestionDraft =>
      drafts[id] ?? { selected: [], other: '' };

    const update = (id: string, next: Partial<QuestionDraft>) =>
      setDrafts((all) => ({ ...all, [id]: { ...draftOf(id), ...next } }));

    const pick = (item: AgentQuestionItem, label: string) => {
      const { selected } = draftOf(item.id);

      if (item.multiple) {
        update(item.id, {
          selected: selected.includes(label)
            ? selected.filter((each) => each !== label)
            : [...selected, label],
        });
      } else {
        update(item.id, { selected: [label] });
      }
    };

    const complete = isComplete(items, drafts);

    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && !isPending) {
            answer({
              agentQuestionId: question.id,
              answers: toAnswers(items, drafts),
            });
          }
        }}
      >
        {items.map((item) => (
          <fieldset key={item.id} className="flex flex-col gap-1.5">
            <legend className="mb-1 font-medium">{item.prompt}</legend>

            {hasOptions(item) &&
              item.options?.map((option) => (
                <label
                  key={option.label}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-grayAlpha-50"
                >
                  <input
                    type={item.multiple ? 'checkbox' : 'radio'}
                    name={`${question.id}-${item.id}`}
                    className="mt-1 accent-primary"
                    checked={draftOf(item.id).selected.includes(option.label)}
                    onChange={() => pick(item, option.label)}
                  />
                  <span className="flex flex-col">
                    <span>{option.label}</span>
                    {option.description && (
                      <span className="text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}

            {acceptsOther(item) && (
              <Input
                aria-label={hasOptions(item) ? 'Other' : 'Your answer'}
                placeholder={hasOptions(item) ? 'Other' : 'Your answer'}
                value={draftOf(item.id).other}
                onChange={(event) =>
                  update(item.id, { other: event.target.value })
                }
              />
            )}
          </fieldset>
        ))}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div>
          <Button
            type="submit"
            size="sm"
            isLoading={isPending}
            disabled={!complete || isPending}
          >
            Submit
          </Button>
        </div>
      </form>
    );
  },
);
