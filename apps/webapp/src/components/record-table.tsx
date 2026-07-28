import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vantikhq/ui/components/table';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

/**
 * A list of records, one row each, with a column for every fact about them.
 *
 * The teams list and the products list are the same table. They are the two
 * ways into the two axes of a workspace, and a person who has read one should
 * recognise the other on sight, so they share the table rather than each
 * holding a copy of it. What differs between them is the columns and where a
 * row goes when it is clicked.
 */
interface RecordTableProps<Record> {
  data: Record[];
  columns: Array<ColumnDef<Record>>;
  /** Where a click on a row goes. A row is not clickable without it. */
  onRowClick?: (record: Record) => void;
  /** Shown in place of the rows when there are none. */
  empty?: React.ReactNode;
}

function RecordTableInner<Record>({
  data,
  columns,
  onRowClick,
  empty,
}: RecordTableProps<Record>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="flex items-start w-full">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="text-sm">
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>

        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && 'selected'}
                className={onRowClick ? 'cursor-pointer' : undefined}
                onClick={() => onRowClick && onRowClick(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="py-1">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// `observer` loses the generic, so the cast puts it back. The table reads
// stores through the cells it is given, and those have to stay reactive.
export const RecordTable = observer(
  RecordTableInner,
) as typeof RecordTableInner;
