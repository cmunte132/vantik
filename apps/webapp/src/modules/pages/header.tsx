import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
} from '@vantikhq/ui/components/breadcrumb';
import { Button } from '@vantikhq/ui/components/button';
import { AddLine } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { HeaderLayout } from 'common/header-layout';
import type { PageType } from 'common/types';

interface HeaderProps {
  /** Ancestors of the open page, root first. Empty on the index. */
  ancestors?: PageType[];
  /** The open page, when there is one. */
  page?: PageType;
  /** A trailing crumb for views that are not a page, such as the review inbox. */
  label?: string;
  onCreate?: () => void;
  actions?: React.ReactNode;
}

/**
 * The Pages top bar.
 *
 * Same `HeaderLayout` every other view uses, so Pages carries the sidebar
 * toggle, the breadcrumb and the action slot in the places people already look
 * for them. Building this view without one is what made it read as a different
 * application: the content sat flush against the sidebar with no top chrome and
 * no way back up the tree.
 */
export const Header = observer(
  ({ ancestors = [], page, label, onCreate, actions }: HeaderProps) => {
    const {
      query: { workspaceSlug },
    } = useRouter();

    const create = onCreate ? (
      <Button variant="secondary" className="gap-1" size="sm" onClick={onCreate}>
        <AddLine size={14} />
        New page
      </Button>
    ) : null;

    return (
      <HeaderLayout actions={actions ?? create}>
        <Breadcrumb>
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

          {/* The trail is the point of a tree: "Deployment" under "Runbooks"
              and "Deployment" under "Sales" are different documents. */}
          {ancestors.map((ancestor) => (
            <BreadcrumbItem key={ancestor.id}>
              <Link
                href={{
                  pathname: '/[workspaceSlug]/pages/[pageId]',
                  query: { workspaceSlug, pageId: ancestor.id },
                }}
              >
                <BreadcrumbLink>{ancestor.title}</BreadcrumbLink>
              </Link>
            </BreadcrumbItem>
          ))}

          {page && (
            <BreadcrumbItem>
              <BreadcrumbLink>{page.title || 'Untitled'}</BreadcrumbLink>
            </BreadcrumbItem>
          )}

          {label && (
            <BreadcrumbItem>
              <BreadcrumbLink>{label}</BreadcrumbLink>
            </BreadcrumbItem>
          )}
        </Breadcrumb>
      </HeaderLayout>
    );
  },
);
