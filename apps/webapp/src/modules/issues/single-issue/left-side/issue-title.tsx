import { AdjustableTextArea } from '@vantikhq/ui/components/adjustable-textarea';
import * as React from 'react';

interface IssueTitleProps {
  value: string;
  onChange?: (value: string) => void;
}

// When the issue title changes in the background this doesn't get updated
// TODO: fix this
export function IssueTitle({ value, onChange }: IssueTitleProps) {
  const [inputValue, setInputValue] = React.useState(value);

  // Every keystroke goes straight up: the sheet debounces the save, and a
  // second delay here was one the sheet could not flush when it closed.
  const onInputChange = (value: string) => {
    setInputValue(value);
    onChange && onChange(value);
  };

  return (
    <AdjustableTextArea
      className="border-0 px-6 py-0 font-medium resize-none bg-transparent no-scrollbar overflow-hidden outline-none focus-visible:ring-0 text-xl"
      value={inputValue}
      placeholder="Issue title"
      onChange={onInputChange}
    />
  );
}
