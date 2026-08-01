import type { SelectorItem } from './node-selector';

import {
  RiBold,
  RiItalic,
  RiStrikethrough,
  RiTerminalBoxLine,
  RiUnderline,
} from '@remixicon/react';

import { cn } from '../../../../lib/utils';
import { Button } from '../../button';
import { EditorBubbleItem, useEditor } from '../primitives';

export const TextButtons = () => {
  const { editor } = useEditor();
  if (!editor) {
    return null;
  }
  const items: SelectorItem[] = [
    {
      name: 'bold',
      isActive: (editor) => editor.isActive('bold'),
      command: (editor) => editor.chain().focus().toggleBold().run(),
      icon: RiBold,
    },
    {
      name: 'italic',
      isActive: (editor) => editor.isActive('italic'),
      command: (editor) => editor.chain().focus().toggleItalic().run(),
      icon: RiItalic,
    },
    {
      name: 'underline',
      isActive: (editor) => editor.isActive('underline'),
      command: (editor) => editor.chain().focus().toggleUnderline().run(),
      icon: RiUnderline,
    },
    {
      name: 'strike',
      isActive: (editor) => editor.isActive('strike'),
      command: (editor) => editor.chain().focus().toggleStrike().run(),
      icon: RiStrikethrough,
    },
    {
      name: 'code',
      isActive: (editor) => editor.isActive('code'),
      command: (editor) => editor.chain().focus().toggleCode().run(),
      icon: RiTerminalBoxLine,
    },
  ];
  return (
    <div className="flex">
      {items.map((item, index) => (
        <EditorBubbleItem
          key={index}
          onSelect={(editor) => {
            item.command(editor);
          }}
        >
          <Button
            className="px-2 hover:bg-accent hover:text-accent-foreground"
            variant="ghost"
          >
            <item.icon
              className={cn('h-4 w-4', {
                'text-blue-500': item.isActive(editor),
              })}
            />
          </Button>
        </EditorBubbleItem>
      ))}
    </div>
  );
};
