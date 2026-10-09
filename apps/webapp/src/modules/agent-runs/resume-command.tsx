import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { cn } from '@vantikhq/ui/lib/utils';
import React from 'react';

/**
 * A shell command to continue an omp session in a terminal, with a button
 * that copies it. Plain text in a mono face: the person pastes it, so the
 * words must stay selectable.
 */
export const ResumeCommand = ({
  command,
  className,
}: {
  command: string;
  className?: string;
}) => {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <code className="min-w-0 grow truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <button
        type="button"
        aria-label="Copy resume command"
        title="Copy resume command"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          setCopied(true);
        }}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-grayAlpha-100 hover:text-foreground"
      >
        {copied ? <RiCheckLine size={14} /> : <RiFileCopyLine size={14} />}
      </button>
    </span>
  );
};
