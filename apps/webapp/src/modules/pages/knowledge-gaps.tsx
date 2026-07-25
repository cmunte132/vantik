import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { useKnowledgeGaps } from 'services/pages';

/**
 * Questions agents asked that the bank could not answer.
 *
 * The most valuable signal the system produces, and the one no other surface
 * shows: it says which page to write next, and it turns the bank from a record
 * of what agents dumped into a record of what agents needed. A page created
 * from here is documentation written in response to demand rather than in
 * anticipation of it.
 */
export const KnowledgeGaps = observer(
  ({ onCreatePage }: { onCreatePage: (query: string) => void }) => {
    const { data: gaps, isLoading } = useKnowledgeGaps();

    if (isLoading) {
      return null;
    }

    return (
      <section className="flex flex-col gap-2">
        <h2>Unanswered questions</h2>

        {!gaps || gaps.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing yet. When an agent asks the bank something it cannot answer,
            the question shows up here.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Asked by agents, answered by nothing in the bank. Most-asked
              first.
            </p>

            <div className="flex flex-col gap-1">
              {gaps.map((gap) => (
                <div
                  key={gap.query}
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-grayAlpha-100"
                >
                  <Badge variant="secondary">{gap.count}</Badge>
                  <span className="grow truncate">{gap.query}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCreatePage(gap.query)}
                  >
                    Write a page
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  },
);
