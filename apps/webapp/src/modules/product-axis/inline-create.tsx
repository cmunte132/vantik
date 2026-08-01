import { RiCloseLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import * as React from 'react';

/**
 * A name field and a Create button, opened by the action in the page header.
 *
 * The row appears at the top of the list it adds to, so what you type and what
 * you get are the same place. This is why none of the three lists has a settings
 * screen: the thing you manage and the control that manages it are together.
 */
export function InlineCreate({
  placeholder,
  onCreate,
  onClose,
  children,
  disabled,
}: {
  placeholder: string;
  onCreate: (name: string) => void;
  onClose: () => void;
  /** Extra controls, such as the owner of a module. */
  children?: React.ReactNode;
  /** Set when something else is still needed, such as an owner. */
  disabled?: boolean;
}) {
  const [name, setName] = React.useState('');

  const create = () => {
    if (!name.trim() || disabled) {
      return;
    }

    onCreate(name.trim());
    setName('');
    onClose();
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <Input
        autoFocus
        placeholder={placeholder}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            create();
          }

          if (event.key === 'Escape') {
            onClose();
          }
        }}
      />

      {children}

      <Button
        variant="secondary"
        disabled={!name.trim() || disabled}
        onClick={create}
      >
        Create
      </Button>

      <Button variant="ghost" size="sm" onClick={onClose} aria-label="Cancel">
        <RiCloseLine size={14} />
      </Button>
    </div>
  );
}
