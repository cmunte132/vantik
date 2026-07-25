import { Textarea } from '@vantikhq/ui/components/textarea';
import * as React from 'react';
import { useDebouncedCallback } from 'use-debounce';

interface PageTitleProps {
  value: string;
  onChange?: (value: string) => void;
}

/**
 * The page title, in the same shape as `ProjectTitle`.
 *
 * A textarea rather than an input, for the reason the rest of the app uses one:
 * a title that wraps stays readable instead of scrolling sideways inside a
 * single line. Mount this with `key={page.id}` so navigating the tree resets
 * the local value — otherwise the previous page's title sits above the new
 * page's body.
 */
export function PageTitle({ value, onChange }: PageTitleProps) {
  const [inputValue, setInputValue] = React.useState(value);

  const debouncedUpdates = useDebouncedCallback(async (title: string) => {
    onChange && onChange(title);
  }, 500);

  const onInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(event.currentTarget.value);
    debouncedUpdates(event.currentTarget.value);
  };

  return (
    <Textarea
      className="border-0 px-0 py-0 font-medium resize-none bg-transparent no-scrollbar overflow-hidden outline-none focus-visible:ring-0 text-xl"
      rows={1}
      cols={1}
      value={inputValue}
      placeholder="Untitled page"
      onChange={onInputChange}
    />
  );
}
