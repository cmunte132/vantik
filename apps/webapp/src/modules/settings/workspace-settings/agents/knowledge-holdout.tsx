import { Loader } from '@vantikhq/ui/components/loader';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vantikhq/ui/components/table';
import * as React from 'react';

import { useKnowledgeArms } from 'services/agent-runs';

import { armRows, sampleWarning } from './knowledge-arms';

/**
 * Whether the knowledge handed to runs is helping.
 *
 * A share of runs is held out and gets none; this sets the two side by side.
 * The sample comes first and every figure carries what it was measured over,
 * because for a long while an arm is a handful of runs, and a percentage off a
 * handful is noise that reads like a result.
 */
export function KnowledgeHoldout({ enabled }: { enabled: boolean }) {
  const { data, isLoading, isError } = useKnowledgeArms(enabled);

  if (isLoading) {
    return <Loader />;
  }

  if (isError || !data) {
    return (
      <p className="text-muted-foreground">
        The comparison could not be loaded.
      </p>
    );
  }

  const warning = sampleWarning(data);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        {Math.round(data.holdoutRate * 100)}% of new runs are held out. Set
        KNOWLEDGE_HOLDOUT_RATE on the server to change it.
      </p>

      {warning && <p className="text-amber-600">{warning}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Arm</TableHead>
            <TableHead>Finished runs</TableHead>
            <TableHead>Checks passed</TableHead>
            <TableHead>Review passes</TableHead>
            <TableHead>Cost per run</TableHead>
            <TableHead>Pull requests merged</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {armRows(data).map((row) => (
            <TableRow key={row.label}>
              <TableCell>{row.label}</TableCell>
              <TableCell>{row.runs}</TableCell>
              <TableCell>{row.verification}</TableCell>
              <TableCell>{row.reviewPasses}</TableCell>
              <TableCell>{row.cost}</TableCell>
              <TableCell>{row.merged}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
