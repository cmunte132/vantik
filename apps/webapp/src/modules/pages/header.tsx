import { RiAddLine, RiInboxLine } from '@remixicon/react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
} from '@vantikhq/ui/components/breadcrumb';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { HeaderLayout } from 'common/header-layout';

import { useKnowledgeOverview } from 'services/pages';

import { NEED_YOU_BADGE } from './trust';

/** One step of the trail. A crumb with no route is the view you are on. */
export interface Crumb {
  label: React.ReactNode;
  pathname?: string;
  query?: Record<string, string>;
}

interface HeaderProps {
  /** The crumbs after "Pages". */
  crumbs?: Crumb[];
  /** Quiet text after the trail, such as "3 other pages in Vantik App". */
  note?: React.ReactNode;
  onCreate?: () => void;
  actions?: React.ReactNode;
  /** Shows the Needs you indicator. On by default. */
  needsYou?: boolean;
}

/**
 * The Pages top bar: the trail back to the Pages home, and on the right what
 * waits on a person and the actions of the view.
 */
export const Header = observer(
  ({ crumbs = [], note, onCreate, actions, needsYou = true }: HeaderProps) => {
    const {
      query: { workspaceSlug },
    } = useRouter();

    return (
      <HeaderLayout
        actions={
          <div className="flex items-center gap-2">
            {actions}
            {needsYou && <NeedsYou />}
            {onCreate && (
              <Button
                variant="secondary"
                className="gap-1"
                size="sm"
                onClick={onCreate}
              >
                <RiAddLine size={14} />
                New page
              </Button>
            )}
          </div>
        }
      >
        <Breadcrumb className="min-w-0">
          <BreadcrumbItem>
            <Link
              href={{
                pathname: '/[workspaceSlug]/pages',
                query: { workspaceSlug },
              }}
            >
              <BreadcrumbLink>Pages</BreadcrumbLink>
            </Link>
          </BreadcrumbItem>

          {crumbs.map((crumb, index) => (
            <BreadcrumbItem key={index} className="min-w-0">
              {crumb.pathname ? (
                <Link
                  href={{
                    pathname: crumb.pathname,
                    query: { workspaceSlug, ...crumb.query },
                  }}
                >
                  <BreadcrumbLink>{crumb.label}</BreadcrumbLink>
                </Link>
              ) : typeof crumb.label === 'string' ? (
                <BreadcrumbLink className="truncate">
                  {crumb.label}
                </BreadcrumbLink>
              ) : (
                crumb.label
              )}
            </BreadcrumbItem>
          ))}
        </Breadcrumb>

        {note && (
          <span className="ml-2 text-xs text-muted-foreground truncate hidden md:inline">
            {note}
          </span>
        )}
      </HeaderLayout>
    );
  },
);

/**
 * How many things wait on a person, and the way to them. It is an
 * indicator, not a view of its own: it leads to the review inbox.
 */
export const NeedsYou = observer(() => {
  const {
    query: { workspaceSlug },
  } = useRouter();
  const { data } = useKnowledgeOverview();
  const count = data?.facts.needYou ?? 0;

  return (
    <Link
      href={{
        pathname: '/[workspaceSlug]/pages/review',
        query: { workspaceSlug },
      }}
      className="flex items-center gap-2 h-7 pl-2.5 pr-1.5 rounded-lg bg-background-3 shadow-[0_0_0_1px_oklch(0%_0_0/0.1)] font-medium whitespace-nowrap"
    >
      <RiInboxLine size={14} />
      Needs you
      {count > 0 ? (
        <span className={NEED_YOU_BADGE}>{count}</span>
      ) : (
        <span className="text-xs text-muted-foreground pr-1">0</span>
      )}
    </Link>
  );
});
