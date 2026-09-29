import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useKnowledgeOverview } from 'services/pages';
import { weekSentence } from 'services/pages/overview';

import { Header } from './header';
import { ago, CARD, FIGURE_TONE } from './trust';

/**
 * What the gardener did this week. It is the first part of the gardener
 * view: its log, its jobs and the life of a fact come with ENG-228.
 */
const GardenerView = observer(() => {
  const { data: overview } = useKnowledgeOverview();

  return (
    <MainLayout scrollable header={<Header crumbs={[{ label: 'Gardener' }]} />}>
      <div className="px-4 py-5 md:px-7 md:py-6 flex flex-col gap-5 max-w-[960px]">
        {overview && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xl font-semibold">Gardener</span>
              <span className="text-foreground/80">
                {overview.gardenerAt
                  ? `Last acted ${ago(overview.gardenerAt)}. `
                  : 'It has not acted yet. '}
                Triage is {overview.autoTriage}
                {overview.autoTriage === 'shadow'
                  ? ': it records what it would do, and a person still decides.'
                  : '.'}
              </span>
            </div>

            <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
              <Stat
                value={overview.week.written}
                label="facts agents wrote this week"
              />
              <Stat
                value={overview.week.settled}
                label={
                  overview.autoTriage === 'on'
                    ? 'settled without a person'
                    : 'it would have settled'
                }
                tone={FIGURE_TONE.code}
              />
              <Stat
                value={overview.week.settledObserved}
                label="of those, observations of outside services"
                tone={FIGURE_TONE.observed}
              />
              <Stat
                value={overview.week.gapsClosed}
                label="gaps closed this week"
                tone={FIGURE_TONE.people}
              />
            </div>

            <p className="leading-normal text-foreground/80">
              {weekSentence(overview)}
            </p>
          </>
        )}
      </div>
    </MainLayout>
  );
});

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: string;
}) {
  return (
    <div className={cn(CARD, 'px-4 py-3.5 flex flex-col gap-0.5')}>
      <span className={cn('text-[26px] font-semibold leading-tight', tone)}>
        {value}
      </span>
      <span className="text-foreground/75">{label}</span>
    </div>
  );
}

export function Gardener() {
  return <GardenerView />;
}

Gardener.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
