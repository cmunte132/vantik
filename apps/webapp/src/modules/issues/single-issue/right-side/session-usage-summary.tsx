import {
  issueUsageLines,
  type SessionUsage,
  sessionUsageLines,
  type UsageLine,
} from './session-usage';

interface Props {
  usage: SessionUsage | undefined;
  isPending: boolean;
  isError: boolean;
}

/**
 * The usage of this session, above its activity. The figures are estimates,
 * kept apart by billing route, and the title never says they were spent.
 */
export const SessionUsageSummary = ({ usage, isPending, isError }: Props) => {
  if (isPending) {
    return <p className="py-2 text-sm text-muted-foreground">Loading usage.</p>;
  }
  if (isError || !usage) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Usage is not available.
      </p>
    );
  }

  return (
    <section aria-label="Usage" className="mb-4 space-y-3 text-sm">
      <UsageList
        heading="This issue (estimates)"
        lines={issueUsageLines(usage)}
        empty="No priced calls for this issue yet."
      />
      <UsageList
        heading="Whole session (estimates)"
        lines={sessionUsageLines(usage)}
        empty="No priced calls in this session yet."
      />
    </section>
  );
};

const UsageList = ({
  heading,
  lines,
  empty,
}: {
  heading: string;
  lines: UsageLine[];
  empty: string;
}) => (
  <div>
    <h3 className="font-medium">{heading}</h3>
    {lines.length === 0 ? (
      <p className="text-muted-foreground">{empty}</p>
    ) : (
      <ul className="mt-1 space-y-1">
        {lines.map((line) => (
          <li key={line.label}>
            <span>{line.label}</span>{' '}
            <span className="tabular-nums">{line.amount}</span>
            {line.note ? (
              <span className="block text-xs text-muted-foreground">
                {line.note}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    )}
  </div>
);
