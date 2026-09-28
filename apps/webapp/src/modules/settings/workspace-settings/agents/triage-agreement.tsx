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

import { useKnowledgeAgreement } from 'services/pages';

import { agreementNote, agreementRows } from './knowledge-agreement';

/**
 * How far triage and the people reviewing it agree, per kind of decision.
 *
 * Kappa rather than a plain share agreed, because triage mostly accepts: a
 * rule that accepted everything would agree with people most of the time and
 * know nothing. The verdict counts sit beside it for the same reason the
 * holdout panel shows its runs: early on there are few, and a kappa off a
 * handful says little.
 */
export function TriageAgreement({ enabled }: { enabled: boolean }) {
  const { data, isLoading, isError } = useKnowledgeAgreement(enabled);

  if (isLoading) {
    return <Loader />;
  }

  if (isError || !data) {
    return (
      <p className="text-muted-foreground">Agreement could not be loaded.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">{agreementNote(data)}</p>

      {data.autoTriage !== 'off' && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Decision</TableHead>
              <TableHead>Kappa</TableHead>
              <TableHead>Verdicts</TableHead>
              <TableHead>How they fell</TableHead>
              <TableHead>Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agreementRows(data).map((row) => (
              <TableRow key={row.decision}>
                <TableCell>{row.label}</TableCell>
                <TableCell>{row.kappa}</TableCell>
                <TableCell>{row.verdicts}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.cells}
                </TableCell>
                <TableCell className={row.heldBack ? 'text-amber-600' : ''}>
                  {row.state}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
