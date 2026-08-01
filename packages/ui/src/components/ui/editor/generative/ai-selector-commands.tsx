import { RiSkipForwardLine } from '@remixicon/react';

import { CommandItem, CommandList } from '@vantikhq/ui/components/command';
import { SubIssue } from '@vantikhq/ui/icons';

import { useEditor } from '../primitives';
import { getPrevText } from '../primitives';

const options = [
  {
    value: 'generate-sub-issues',
    label: 'Generate sub issues',
    icon: SubIssue,
  },
];

interface AISelectorCommandsProps {
  onSelect: (value: string, option: string) => void;
}

const AISelectorCommands = ({ onSelect }: AISelectorCommandsProps) => {
  const { editor } = useEditor();

  return (
    <>
      <CommandList className="p-1">
        {options.map((option) => (
          <CommandItem
            onSelect={(value) => {
              const slice = editor.state.selection.content();
              // tiptap-markdown registers this storage at runtime but only
              // augments Tiptap 2's Storage interface, so it is invisible to
              // the compiler on Tiptap 3.
              const { markdown } = editor.storage as unknown as {
                markdown: {
                  serializer: { serialize: (content: unknown) => string };
                };
              };
              const text = markdown.serializer.serialize(slice.content);
              onSelect(text, value);
            }}
            className="flex gap-2 px-2"
            key={option.value}
            value={option.value}
          >
            <option.icon className="h-4 w-4" />
            {option.label}
          </CommandItem>
        ))}

        <CommandItem
          onSelect={() => {
            const pos = editor.state.selection.from;

            const text = getPrevText(editor, pos);
            onSelect(text, 'continue');
          }}
          value="continue"
          className="gap-2 px-2"
        >
          <RiSkipForwardLine className="h-4 w-4" />
          Continue writing
        </CommandItem>
      </CommandList>
    </>
  );
};

export default AISelectorCommands;
