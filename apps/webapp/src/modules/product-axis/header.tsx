import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
} from '@vantikhq/ui/components/breadcrumb';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import React from 'react';

import { HeaderLayout } from 'common/header-layout';

interface Crumb {
  title: string;
  href?: string;
}

interface HeaderProps {
  crumbs: Crumb[];
  actions?: React.ReactNode;
}

export const Header = observer(({ crumbs, actions }: HeaderProps) => (
  <HeaderLayout actions={actions}>
    <Breadcrumb>
      {crumbs.map((crumb) => (
        <BreadcrumbItem key={`${crumb.title}-${crumb.href ?? ''}`}>
          {/*
            `BreadcrumbLink` makes the anchor itself. A `Link` around it makes
            a second anchor inside the first, and the browser refuses that.
          */}
          {crumb.href ? (
            <BreadcrumbLink as={Link} href={crumb.href}>
              {crumb.title}
            </BreadcrumbLink>
          ) : (
            <BreadcrumbLink>{crumb.title}</BreadcrumbLink>
          )}
        </BreadcrumbItem>
      ))}
    </Breadcrumb>
  </HeaderLayout>
));
