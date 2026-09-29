import { RiArrowLeftLine } from '@remixicon/react';
import {
  KnowledgeInboxChoiceEnum,
  KnowledgeInboxKindEnum,
  RoleEnum,
  type KnowledgeInboxDetail,
  type KnowledgeInboxItem,
  type KnowledgeInboxView,
} from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { getTailwindColor } from '@vantikhq/ui/lib/color-utils';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { useNewIssue } from 'modules/issues/new-issue/new-issue-provider';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import type { PageType, User } from 'common/types';

import { useAllUsers } from 'hooks/users';

import {
  type ProvenEntry,
  useAssignInboxItemMutation,
  useCommentInboxItemMutation,
  useCreatePageEntryMutation,
  useDecideInboxItemMutation,
  useKnowledgeInbox,
  useKnowledgeInboxItem,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { FactTrailDialog } from './fact-trail';
import {
  doneLine,
  eventLine,
  inboxChoices,
  inboxExplanation,
  inboxReason,
  inboxSubline,
  inboxTitle,
  isToday,
  KIND_LABELS,
} from './inbox';
import { citationLabel } from './memory-rail';
import { age, ago, CARD, Chip, CHIP_TONE } from './trust';

const VIEWS: Array<{ view: KnowledgeInboxView; label: string }> = [
  { view: 'open', label: 'Open' },
  { view: 'mine', label: 'Mine' },
  { view: 'unassigned', label: 'Unassigned' },
  { view: 'done', label: 'Done' },
];

const DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

/** The people of the workspace, who can be put on an item. Not agents. */
function useMembers() {
  const { workspaceStore } = useContextStore();
  const { users } = useAllUsers(false);
  const members = users.filter(
    (user) =>
      user.role !== RoleEnum.AGENT &&
      workspaceStore.usersOnWorkspaces.some(
        (member: { userId: string }) => member.userId === user.id,
      ),
  );
  const nameOf = React.useCallback(
    (userId: string | null) => {
      const user = users.find((candidate) => candidate.id === userId);

      return user ? user.fullname || user.username : null;
    },
    [users],
  );

  return { members, nameOf };
}

/** A person's initial on a round swatch, as the board draws them. */
function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        'w-5 h-5 rounded-full text-white text-[11px] font-semibold flex items-center justify-center shrink-0',
        className,
      )}
      style={{ background: getTailwindColor(name) }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Needs you: one inbox, shared by the workspace, for every knowledge
 * decision that waits on a person. The list is on the left, and the item
 * open on the right, with what deciding it needs and who said what.
 */
const NeedsYouView = observer(() => {
  const router = useRouter();
  const {
    workspaceSlug,
    item: itemParam,
    subject,
    page,
    view: viewParam,
  } = router.query as Record<string, string | undefined>;
  const view = (VIEWS.find((candidate) => candidate.view === viewParam)?.view ??
    'open') as KnowledgeInboxView;
  const { pagesStore } = useContextStore();
  const { members, nameOf } = useMembers();

  const { data: list } = useKnowledgeInbox(view, page);
  const { data: done } = useKnowledgeInbox('done', page);
  const items = React.useMemo(() => list?.items ?? [], [list]);
  const doneToday =
    view === 'open'
      ? (done?.items ?? []).filter((item) => isToday(item.doneAt))
      : [];

  const go = React.useCallback(
    (query: Record<string, string | undefined>) => {
      const next = { ...router.query, ...query };

      for (const key of Object.keys(next)) {
        if (next[key] === undefined) {
          delete next[key];
        }
      }

      router.replace({ pathname: router.pathname, query: next }, undefined, {
        shallow: true,
      });
    },
    [router],
  );

  // An item named by the fact or the proposal it is about, as the page
  // views link here, is opened by its row.
  const named = subject
    ? [...items, ...(done?.items ?? [])].find(
        (item) => item.subjectId === subject || item.entry?.id === subject,
      )
    : undefined;
  const selectedId = itemParam ?? named?.id;

  // On a wide screen the first item opens, so the right side is never empty
  // while something waits.
  React.useEffect(() => {
    if (
      !selectedId &&
      items.length > 0 &&
      window.matchMedia('(min-width: 768px)').matches
    ) {
      go({ item: items[0].id, subject: undefined });
    }
  }, [selectedId, items, go]);

  const pageTitle = page
    ? pagesStore.getPageWithId(page)?.title || 'Untitled page'
    : null;

  return (
    <MainLayout header={null}>
      <div className="flex h-full min-h-0">
        <section
          className={cn(
            'w-full md:w-[400px] shrink-0 flex flex-col min-h-0 bg-background-3 border-r border-border',
            selectedId && 'hidden md:flex',
          )}
        >
          <header className="h-[46px] shrink-0 px-3.5 flex items-center gap-2 border-b border-border">
            <Link
              href={{
                pathname: '/[workspaceSlug]/pages',
                query: { workspaceSlug },
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              Pages
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-semibold grow">Needs you</span>
            <span className="text-xs text-muted-foreground">
              Shared with {members.length}{' '}
              {members.length === 1 ? 'member' : 'members'}
            </span>
          </header>

          <div className="flex items-center gap-1 px-3.5 py-2 border-b border-grayAlpha-100 flex-wrap">
            {VIEWS.map(({ view: candidate, label }) => (
              <button
                key={candidate}
                type="button"
                className={cn(
                  'text-xs px-2.5 py-[3px] rounded-[7px]',
                  view === candidate
                    ? 'font-medium bg-grayAlpha-100'
                    : 'text-foreground/75 hover:bg-grayAlpha-100',
                )}
                onClick={() => go({ view: candidate, item: undefined })}
              >
                {label}
                {candidate !== 'done' &&
                  list &&
                  ` ${list.counts[candidate as Exclude<KnowledgeInboxView, 'done'>]}`}
              </button>
            ))}
            <Link
              href={{
                pathname: '/[workspaceSlug]/pages/gardener',
                query: { workspaceSlug },
              }}
              className="ml-auto text-xs text-[oklch(48%_0.13_240)] dark:text-[oklch(75%_0.1_240)]"
            >
              Settled by agents {list?.settledByAgents ?? 0}
            </Link>
          </div>

          {pageTitle && (
            <div className="flex items-center gap-2 px-3.5 py-2 border-b border-grayAlpha-100 text-xs">
              <span className="text-muted-foreground grow truncate">
                On {pageTitle}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => go({ page: undefined, item: undefined })}
              >
                Show all
              </button>
            </div>
          )}

          <div className="flex flex-col overflow-y-auto min-h-0">
            {list && items.length === 0 && (
              <div className="px-3.5 py-6 text-muted-foreground">
                {view === 'done'
                  ? 'Nothing decided in the last 30 days.'
                  : 'Nothing waits on a person here.'}
              </div>
            )}

            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                nameOf={nameOf}
                onSelect={() => go({ item: item.id, subject: undefined })}
              />
            ))}

            {doneToday.length > 0 && (
              <>
                <div className="px-3.5 pt-2.5 pb-1.5 text-xs font-semibold text-foreground/70">
                  Done today
                </div>
                {doneToday.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    nameOf={nameOf}
                    onSelect={() => go({ item: item.id, subject: undefined })}
                  />
                ))}
              </>
            )}
          </div>
        </section>

        <section
          className={cn(
            'grow min-w-0 flex flex-col min-h-0',
            !selectedId && 'hidden md:flex',
          )}
        >
          {selectedId ? (
            <Detail
              key={selectedId}
              id={selectedId}
              members={members}
              nameOf={nameOf}
              onBack={() => go({ item: undefined, subject: undefined })}
              onDecided={() => {
                const index = items.findIndex((item) => item.id === selectedId);
                const next = items[index + 1] ?? items[index - 1];

                go({ item: next?.id, subject: undefined });
              }}
            />
          ) : (
            <div className="m-auto text-muted-foreground">
              {list && items.length === 0 ? 'Nothing waits on a person.' : null}
            </div>
          )}
        </section>
      </div>
    </MainLayout>
  );
});

/** One item in the list. */
function Row({
  item,
  selected,
  nameOf,
  onSelect,
}: {
  item: KnowledgeInboxItem;
  selected: boolean;
  nameOf: (userId: string | null) => string | null;
  onSelect: () => void;
}) {
  const kind = KIND_LABELS[item.kind];
  const isDone = Boolean(item.doneAt);
  // An audit asks about something agents already settled, so it does not
  // call for attention the way the rest do.
  const urgent = !isDone && item.kind !== KnowledgeInboxKindEnum.AUDIT;
  const person = isDone ? item.doneById : item.assigneeId;
  const name = nameOf(person);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex gap-2.5 px-3.5 py-[11px] border-b border-grayAlpha-100 text-left',
        selected ? 'bg-[oklch(60%_0.13_240/0.09)]' : 'hover:bg-grayAlpha-50',
      )}
    >
      <span
        className={cn(
          'w-[7px] h-[7px] rounded-full shrink-0 mt-1.5',
          urgent && 'bg-[oklch(58%_0.19_45)]',
        )}
      />
      <span className="flex flex-col gap-1 min-w-0 grow">
        <span
          className={cn(
            'leading-snug line-clamp-2 break-words',
            urgent ? 'font-semibold' : 'font-normal',
            isDone && 'text-muted-foreground',
          )}
        >
          {inboxTitle(item)}
        </span>
        <span className="flex items-center gap-1.5 flex-wrap">
          {!isDone && (
            <span
              className={cn(
                'text-[11.5px] font-medium px-[7px] py-px rounded-full',
                kind.tone
                  ? CHIP_TONE[kind.tone]
                  : 'bg-grayAlpha-100 text-foreground/75',
              )}
            >
              {kind.label}
            </span>
          )}
          <span className="text-xs text-muted-foreground truncate">
            {isDone ? doneLine(item, nameOf) : inboxSubline(item)}
          </span>
        </span>
      </span>
      <span className="shrink-0 flex flex-col items-end gap-1.5">
        <span className="text-xs text-muted-foreground">
          {age(isDone ? item.doneAt : item.raisedAt)}
        </span>
        {name ? (
          <Initial name={name} />
        ) : (
          !isDone && (
            <span className="text-[11.5px] text-muted-foreground">
              Unassigned
            </span>
          )
        )}
      </span>
    </button>
  );
}

/** The item open on the right. */
const Detail = observer(
  ({
    id,
    members,
    nameOf,
    onBack,
    onDecided,
  }: {
    id: string;
    members: User[];
    nameOf: (userId: string | null) => string | null;
    onBack: () => void;
    onDecided: () => void;
  }) => {
    const {
      query: { workspaceSlug },
    } = useRouter();
    const currentUser = React.useContext(UserContext);
    const { data, isError } = useKnowledgeInboxItem(id);
    const [error, setError] = React.useState<string | null>(null);
    const [opened, setOpened] = React.useState<ProvenEntry | null>(null);
    const { openNewIssue } = useNewIssue() ?? {};
    const { mutate: assign } = useAssignInboxItemMutation({
      onError: setError,
    });
    const { mutate: decide, isPending: deciding } = useDecideInboxItemMutation({
      onMutate: () => setError(null),
      onSuccess: onDecided,
      onError: setError,
    });

    if (isError) {
      return (
        <div className="m-auto text-muted-foreground">
          This item is not in this workspace.
        </div>
      );
    }

    if (!data) {
      return null;
    }

    const { item } = data;
    const title = inboxTitle(item);
    const assignee = nameOf(item.assigneeId);
    const isDone = Boolean(item.doneAt);
    const choices = inboxChoices(item);

    return (
      <>
        <header className="h-[46px] shrink-0 px-5 flex items-center gap-2.5 border-b border-border">
          <button
            type="button"
            className="md:hidden text-muted-foreground"
            aria-label="Back to the list"
            onClick={onBack}
          >
            <RiArrowLeftLine size={16} />
          </button>
          <span className="text-xs text-muted-foreground grow truncate">
            {item.pageId ? (
              <>
                From{' '}
                <Link
                  href={{
                    pathname: '/[workspaceSlug]/pages/[pageId]',
                    query: { workspaceSlug, pageId: item.pageId },
                  }}
                  className="text-[oklch(48%_0.13_240)] dark:text-[oklch(75%_0.1_240)]"
                >
                  {item.pageTitle ?? 'Untitled page'}
                </Link>{' '}
                ·{' '}
              </>
            ) : item.entry ? (
              'Outside any page · '
            ) : null}
            raised by {item.raisedBy} {ago(item.raisedAt)}
          </span>

          {!isDone && (
            <>
              <span className="flex items-center gap-1.5 text-xs text-foreground/80 whitespace-nowrap">
                {assignee ? (
                  <>
                    <Initial name={assignee} />
                    {item.assigneeId === currentUser?.id
                      ? 'You are on it'
                      : `${assignee} is on it`}
                  </>
                ) : (
                  <span className="text-muted-foreground">No one is on it</span>
                )}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm">
                    {assignee ? 'Reassign' : 'Assign'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {members.map((member) => (
                    <DropdownMenuItem
                      key={member.id}
                      onSelect={() =>
                        assign({ id: item.id, assigneeId: member.id })
                      }
                    >
                      <Initial
                        name={member.fullname || member.username}
                        className="mr-2"
                      />
                      {member.id === currentUser?.id
                        ? 'Me'
                        : member.fullname || member.username}
                    </DropdownMenuItem>
                  ))}
                  {item.assigneeId && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          assign({ id: item.id, assigneeId: null })
                        }
                      >
                        Take everyone off it
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </header>

        <div className="grow min-h-0 overflow-y-auto">
          <div className="px-7 py-6 flex flex-col gap-4 max-w-[860px]">
            <div className="flex flex-col gap-2">
              <Chip
                tone={isDone ? undefined : 'needYou'}
                className="self-start"
              >
                {isDone ? doneLine(item, nameOf) : inboxReason(item)}
              </Chip>
              <h1 className="text-xl font-semibold leading-tight break-words">
                {title}
              </h1>
              <p className="leading-normal text-foreground/80">
                {inboxExplanation(item)}
              </p>
            </div>

            <Subject data={data} nameOf={nameOf} onOpen={setOpened} />

            {!isDone && item.kind === KnowledgeInboxKindEnum.GAP && (
              <AnswerGap
                query={item.gap?.query ?? ''}
                onAnswered={(entryId) =>
                  decide({
                    id: item.id,
                    choice: KnowledgeInboxChoiceEnum.ANSWER,
                    entryId,
                  })
                }
                onError={setError}
              />
            )}

            {!isDone && (choices.length > 0 || openNewIssue) && (
              <div className="flex gap-2 flex-wrap">
                {choices.map(({ choice, label }, index) => (
                  <Button
                    key={choice}
                    variant={index === 0 ? 'default' : 'secondary'}
                    disabled={deciding}
                    onClick={() => decide({ id: item.id, choice })}
                  >
                    {label}
                  </Button>
                ))}
                {openNewIssue && (
                  <Button
                    variant="ghost"
                    onClick={() => openNewIssue({ title })}
                  >
                    Open an issue
                  </Button>
                )}
              </div>
            )}

            {error && <span className="text-destructive">{error}</span>}

            <Activity
              id={item.id}
              events={data.events}
              nameOf={nameOf}
              onError={setError}
            />
          </div>
        </div>

        <FactTrailDialog fact={opened} onClose={() => setOpened(null)} />
      </>
    );
  },
);

/** The fact, the facts it contradicts, or the rewrite, as deciding needs them. */
function Subject({
  data,
  nameOf,
  onOpen,
}: {
  data: KnowledgeInboxDetail;
  nameOf: (userId: string | null) => string | null;
  onOpen: (fact: ProvenEntry) => void;
}) {
  const { item, fact, contradicts, rewrite } = data;

  if (rewrite) {
    return (
      <div className={cn(CARD, 'px-3.5 py-3 flex flex-col gap-1.5')}>
        <span className="text-xs font-semibold text-[oklch(45%_0.13_240)] dark:text-[oklch(78%_0.1_240)]">
          The new body of {rewrite.pageTitle}
        </span>
        <div className="leading-normal whitespace-pre-wrap break-words max-h-[420px] overflow-y-auto">
          {rewrite.bodyMarkdown}
        </div>
      </div>
    );
  }

  const shown = fact ?? (item.entry as unknown as ProvenEntry | null);

  if (!shown) {
    return null;
  }

  if (
    item.kind === KnowledgeInboxKindEnum.CONTRADICTION &&
    contradicts.length
  ) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-3">
          {contradicts.map((old) => (
            <FactCard
              key={old.id}
              fact={old as unknown as ProvenEntry}
              nameOf={nameOf}
              onOpen={onOpen}
            />
          ))}
        </div>
        <FactCard fact={shown as ProvenEntry} nameOf={nameOf} onOpen={onOpen} />
      </div>
    );
  }

  return (
    <div className="max-w-[560px]">
      <FactCard fact={shown as ProvenEntry} nameOf={nameOf} onOpen={onOpen} />
    </div>
  );
}

/** One fact, headed by what it rests on, with the lines it cites. */
function FactCard({
  fact,
  nameOf,
  onOpen,
}: {
  fact: ProvenEntry;
  nameOf: (userId: string | null) => string | null;
  onOpen: (fact: ProvenEntry) => void;
}) {
  const citations = fact.citations ?? [];
  const confirmedBy = fact.verifiedAt
    ? (nameOf(fact.verifiedByUserId) ?? 'a person')
    : null;
  const [headline, tone] = confirmedBy
    ? [
        [
          `Confirmed by ${confirmedBy}`,
          DATE.format(new Date(fact.verifiedAt as string)),
          citations.length ? null : 'no source',
        ]
          .filter(Boolean)
          .join(' · '),
        'text-[oklch(45%_0.13_240)] dark:text-[oklch(78%_0.1_240)]',
      ]
    : fact.trust === 'GROUNDED'
      ? [
          'Code confirms',
          'text-[oklch(42%_0.1_154)] dark:text-[oklch(78%_0.1_154)]',
        ]
      : [
          [
            `Written by ${nameOf(fact.sourceUserId) ?? 'an agent'}`,
            DATE.format(new Date(fact.createdAt)),
            citations.length ? null : 'no source',
          ]
            .filter(Boolean)
            .join(' · '),
          'text-muted-foreground',
        ];

  return (
    <button
      type="button"
      className={cn(
        CARD,
        'px-3.5 py-3 flex flex-col gap-1.5 text-left hover:border-grayAlpha-300',
      )}
      onClick={() => onOpen(fact)}
    >
      <span className={cn('text-xs font-semibold', tone)}>{headline}</span>
      <span className="leading-normal break-words">{fact.content}</span>
      {citations.length > 0 && (
        <span className="font-mono text-xs bg-grayAlpha-50 rounded-md px-2.5 py-2 flex flex-col gap-0.5 text-foreground/85 w-full">
          {citations.map((citation, index) => (
            <span key={index} className="break-words">
              {citationLabel(citation)}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** One fact, on a page the person picks, that answers a gap. */
const AnswerGap = observer(
  ({
    query,
    onAnswered,
    onError,
  }: {
    query: string;
    onAnswered: (entryId: string) => void;
    onError: (error: string) => void;
  }) => {
    const { pagesStore } = useContextStore();
    const [pageId, setPageId] = React.useState<string>();
    const [content, setContent] = React.useState('');
    const { mutate: create, isPending } = useCreatePageEntryMutation({
      onSuccess: (entry) => onAnswered(entry.id),
      onError,
    });
    const pages: PageType[] = [...pagesStore.getPages].sort(
      (a: PageType, b: PageType) => a.title.localeCompare(b.title),
    );

    return (
      <div className={cn(CARD, 'px-3.5 py-3 flex flex-col gap-2.5')}>
        <Select value={pageId} onValueChange={setPageId}>
          <SelectTrigger>
            <SelectValue placeholder="The page the answer belongs on" />
          </SelectTrigger>
          <SelectContent className="max-h-[300px]">
            {pages.map((page) => (
              <SelectItem key={page.id} value={page.id}>
                {page.title || 'Untitled page'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          rows={3}
          value={content}
          placeholder={`One fact that answers “${query}”.`}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setContent(event.currentTarget.value)
          }
        />
        <div className="flex items-center gap-2">
          <span className="grow text-xs text-muted-foreground">
            Agents are given it from now on, and the question is answered.
          </span>
          <Button
            disabled={!pageId || content.trim().length === 0 || isPending}
            onClick={() =>
              pageId &&
              create({ pageId, content: content.trim(), standing: true })
            }
          >
            Answer it
          </Button>
        </div>
      </div>
    );
  },
);

/** Who was put on it, what people said, and what was decided, oldest first. */
function Activity({
  id,
  events,
  nameOf,
  onError,
}: {
  id: string;
  events: KnowledgeInboxDetail['events'];
  nameOf: (userId: string | null) => string | null;
  onError: (error: string) => void;
}) {
  const [body, setBody] = React.useState('');
  const { mutate: comment, isPending } = useCommentInboxItemMutation({
    onSuccess: () => setBody(''),
    onError,
  });
  const send = () => body.trim() && comment({ id, body: body.trim() });

  return (
    <div className="flex flex-col gap-2.5 mt-1.5 pt-4 border-t border-border">
      <span className="text-xs font-semibold text-foreground/75">Activity</span>

      {events.map((event) => {
        const name = nameOf(event.userId);

        if (event.type === 'COMMENTED') {
          return (
            <div key={event.id} className="flex gap-2.5 items-start">
              <Initial name={name ?? '?'} />
              <div
                className={cn(CARD, 'flex flex-col gap-1 px-3 py-2 min-w-0')}
              >
                <span>
                  <span className="font-medium">{name ?? 'Someone'}</span>{' '}
                  <span className="text-muted-foreground">
                    · {ago(event.createdAt)}
                  </span>
                </span>
                <span className="leading-snug whitespace-pre-wrap break-words">
                  {event.body}
                </span>
              </div>
            </div>
          );
        }

        return (
          <div key={event.id} className="flex gap-2.5 items-start">
            {name ? (
              <Initial name={name} />
            ) : (
              <span className="w-5 h-5 rounded-full bg-grayAlpha-200 shrink-0" />
            )}
            <span className="leading-5">
              {name && <span className="font-medium">{name} </span>}
              <span className="text-muted-foreground">
                {eventLine(event, nameOf)} · {ago(event.createdAt)}
              </span>
            </span>
          </div>
        );
      })}

      <div className={cn(CARD, 'flex flex-col gap-2 px-3 py-2')}>
        <Textarea
          rows={1}
          value={body}
          placeholder="Leave a comment…"
          className="border-0 shadow-none px-0 py-0 min-h-0 bg-transparent resize-none focus-visible:ring-0"
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setBody(event.currentTarget.value)
          }
          onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        {body.trim() && (
          <Button
            size="sm"
            variant="secondary"
            className="self-end"
            disabled={isPending}
            onClick={send}
          >
            Comment
          </Button>
        )}
      </div>
    </div>
  );
}

export function NeedsYouInbox() {
  return <NeedsYouView />;
}

NeedsYouInbox.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
