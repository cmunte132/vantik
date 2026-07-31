import { RiCheckLine, RiClipboardLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import copy from 'copy-to-clipboard';
import * as React from 'react';

/**
 * A labelled value you are meant to copy rather than read.
 *
 * Shared by the create form and the setup instructions, which is the reason it
 * sits a directory up from both: the token reveal and the config blocks are the
 * same gesture, and they should not drift into two slightly different ones.
 */
export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = () => {
    copy(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Button variant="ghost" size="xs" onClick={onCopy}>
          {copied ? (
            <RiCheckLine size={14} className="mr-1" />
          ) : (
            <RiClipboardLine size={14} className="mr-1" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-background-3 rounded p-3 text-xs overflow-x-auto whitespace-pre">
        {value}
      </pre>
    </div>
  );
}
