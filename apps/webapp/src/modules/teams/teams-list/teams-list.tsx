import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';

import type { TeamType } from 'common/types';

import { RecordTable } from 'components/record-table';

import { useContextStore } from 'store/global-context-provider';

import { useProjectColumns } from './columns';

export const TeamsList = observer(() => {
  const { teamsStore } = useContextStore();
  const [data, setData] = React.useState(teamsStore.teams);
  const router = useRouter();

  React.useEffect(() => {
    setData(teamsStore.teams.toJSON());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamsStore.teams.length]);

  const columns = useProjectColumns();

  return (
    <RecordTable<TeamType>
      data={data}
      columns={columns}
      /*
        A team opens at its settings rather than at its issues. This list is
        where a person comes to look at a team as a thing — what it is called,
        who is in it, how it works — and the issues have their own way in from
        the sidebar.
      */
      onRowClick={(team) =>
        router.push(
          `/${router.query.workspaceSlug}/settings/teams/${team.identifier}/overview`,
        )
      }
    />
  );
});
