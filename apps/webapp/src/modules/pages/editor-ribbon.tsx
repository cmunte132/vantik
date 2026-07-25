import type { Editor as EditorT } from '@tiptap/core';

import { Button } from '@vantikhq/ui/components/button';
import { Separator } from '@vantikhq/ui/components/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import {
  BoldLine,
  BulletListLine,
  CodingLine,
  HeadingLine,
  IssuesLine,
  ItalicLine,
  LinkLine,
  NumberedListLine,
  StrikeLine,
  TextLine,
  UnderlineLine,
} from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

/**
 * A formatting toolbar for page bodies.
 *
 * The rest of the product has no toolbar — the editor is slash-command and
 * selection-driven, and for an issue description, written in a burst by someone
 * who already knows the app, that is the right call.
 *
 * Documentation is different. A page is the surface people arrive at expecting
 * a document editor, they write in it for longer, and they are far more likely
 * to be a first-time or occasional author. A visible toolbar is how they find
 * out the formatting exists at all: `/` only teaches you what it can do after
 * you already suspect it is there. So this is a deliberate divergence, not an
 * inconsistency.
 *
 * The commands are the same ones the bubble menu runs, so a change to one has
 * to be mirrored in the other — they are duplicated here rather than shared
 * because the bubble menu's components are bound to its own context.
 */

interface RibbonAction {
  name: string;
  hint: string;
  icon: React.ElementType;
  command: (editor: EditorT) => void;
  isActive: (editor: EditorT) => boolean;
}

const BLOCKS: RibbonAction[] = [
  {
    name: 'Text',
    hint: 'Plain paragraph',
    icon: TextLine,
    command: (editor) => editor.chain().focus().clearNodes().run(),
    isActive: (editor) =>
      editor.isActive('paragraph') &&
      !editor.isActive('bulletList') &&
      !editor.isActive('orderedList'),
  },
  {
    name: 'Heading 1',
    hint: 'Big heading',
    icon: HeadingLine,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
  },
  {
    name: 'Heading 2',
    hint: 'Medium heading',
    icon: HeadingLine,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
];

const LISTS: RibbonAction[] = [
  {
    name: 'Bullet list',
    hint: 'Bulleted list',
    icon: BulletListLine,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleBulletList().run(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    name: 'Numbered list',
    hint: 'Numbered list',
    icon: NumberedListLine,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    name: 'To-do list',
    hint: 'Checklist',
    icon: IssuesLine,
    command: (editor) =>
      editor.chain().focus().clearNodes().toggleTaskList().run(),
    isActive: (editor) => editor.isActive('taskItem'),
  },
];

const MARKS: RibbonAction[] = [
  {
    name: 'Bold',
    hint: 'Bold  ⌘B',
    icon: BoldLine,
    command: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor) => editor.isActive('bold'),
  },
  {
    name: 'Italic',
    hint: 'Italic  ⌘I',
    icon: ItalicLine,
    command: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor) => editor.isActive('italic'),
  },
  {
    name: 'Underline',
    hint: 'Underline  ⌘U',
    icon: UnderlineLine,
    command: (editor) => editor.chain().focus().toggleUnderline().run(),
    isActive: (editor) => editor.isActive('underline'),
  },
  {
    name: 'Strikethrough',
    hint: 'Strikethrough',
    icon: StrikeLine,
    command: (editor) => editor.chain().focus().toggleStrike().run(),
    isActive: (editor) => editor.isActive('strike'),
  },
  {
    name: 'Code',
    hint: 'Inline code',
    icon: CodingLine,
    command: (editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor) => editor.isActive('code'),
  },
];

const LINK: RibbonAction = {
  name: 'Link',
  hint: 'Add a link',
  icon: LinkLine,
  command: (editor) => {
    const previous = editor.getAttributes('link').href ?? '';
    // eslint-disable-next-line no-alert
    const href = window.prompt('Link URL', previous);

    if (href === null) {
      return;
    }

    if (href === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  },
  isActive: (editor) => editor.isActive('link'),
};

export function EditorRibbon({ editor }: { editor?: EditorT }) {
  // Active state is derived from the selection, and tiptap mutates the editor
  // in place rather than replacing it — so without subscribing, the buttons
  // would render once and then never light up as the caret moved.
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0);

  React.useEffect(() => {
    if (!editor) {
      return undefined;
    }

    editor.on('selectionUpdate', forceRender);
    editor.on('transaction', forceRender);

    return () => {
      editor.off('selectionUpdate', forceRender);
      editor.off('transaction', forceRender);
    };
  }, [editor]);

  if (!editor) {
    return null;
  }

  const group = (actions: RibbonAction[]) =>
    actions.map((action) => (
      <Tooltip key={action.name}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={action.name}
            aria-pressed={action.isActive(editor)}
            className={cn(
              'px-2',
              action.isActive(editor) && 'bg-grayAlpha-100',
            )}
            // The editor loses its selection to a focused button otherwise, so
            // "bold the selected words" would bold nothing.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => action.command(editor)}
          >
            <action.icon size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{action.hint}</TooltipContent>
      </Tooltip>
    ));

  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 flex-wrap bg-background-2 border-b border-border py-1">
      {group(BLOCKS)}
      <Separator orientation="vertical" className="h-5 mx-1" />
      {group(LISTS)}
      <Separator orientation="vertical" className="h-5 mx-1" />
      {group(MARKS)}
      <Separator orientation="vertical" className="h-5 mx-1" />
      {group([LINK])}

      <span className="text-muted-foreground ml-auto pr-1">
        or press &apos;/&apos;
      </span>
    </div>
  );
}
