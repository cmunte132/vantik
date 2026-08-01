import { RiCloseLine, RiExpandDiagonalLine } from '@remixicon/react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
} from '@vantikhq/ui/components/breadcrumb';
import { Button } from '@vantikhq/ui/components/button';
import { TeamIcon } from '@vantikhq/ui/components/team-icon';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { HeaderLayout } from 'common/header-layout';
import { workspaceHref } from 'common/workspace-href';
import { TooltipWrapper } from 'common/wrappers/tooltip-wrapper';

import { IssueViewContext } from 'components/side-issue-view';
import { useIssueData } from 'hooks/issues';
import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

import { IssueOptionsDropdown } from './issue-actions/issue-options-dropdown';

interface HeaderProps {
  sideView: boolean;
}

export const Header = observer(({ sideView }: HeaderProps) => {
  const team = useCurrentTeam();
  const issue = useIssueData();
  const { push } = useRouter();
  const { teamsStore } = useContextStore();
  const { closeIssueView } = React.useContext(IssueViewContext);

  const {
    query: { issueId, workspaceSlug },
  } = useRouter();

  const openInFull = () => {
    const team = teamsStore.getTeamWithId(issue.teamId);
    closeIssueView();
    push(
      workspaceHref(
        workspaceSlug,
        'issue',
        `${team.identifier}-${issue.number}`,
      ),
    );
  };

  return (
    <HeaderLayout showExpandIcon={!sideView}>
      {!sideView && (
        <Breadcrumb>
          <BreadcrumbItem>
            <BreadcrumbLink
              as={Link}
              className="flex items-center gap-2"
              href={workspaceHref(
                workspaceSlug,
                'team',
                team.identifier,
                'all',
              )}
            >
              <TeamIcon preferences={team.preferences} name={team.name} />
              <span className="inline-block">{team.name}</span>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbLink>{issueId}</BreadcrumbLink>
          </BreadcrumbItem>
        </Breadcrumb>
      )}
      <div className="flex">
        {sideView && (
          <>
            <TooltipWrapper tooltip="Close view (Esc)">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => closeIssueView()}
              >
                <RiCloseLine size={16} />
              </Button>
            </TooltipWrapper>
            <Button variant="ghost" size="sm" onClick={openInFull}>
              <RiExpandDiagonalLine size={16} />
            </Button>
          </>
        )}
        <IssueOptionsDropdown />
      </div>
    </HeaderLayout>
  );
});
