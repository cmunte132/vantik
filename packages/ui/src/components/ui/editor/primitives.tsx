// Local ports of the novel primitives this editor used. novel is pinned to
// Tiptap 2, so the Tiptap 3 migration replaces it with these thin wrappers
// over @tiptap/react (see render-items.tsx for the previously ported pieces).
import type { Editor, Range } from '@tiptap/core';

import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import {
  EditorProvider,
  useCurrentEditor,
  type EditorProviderProps,
} from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import Suggestion from '@tiptap/suggestion';
import * as React from 'react';

export type EditorInstance = Editor;

/** novel's useEditor: the current editor from provider context. */
export const useEditor = useCurrentEditor;

type EditorContentProps = Omit<EditorProviderProps, 'content'> & {
  readonly initialContent?: EditorProviderProps['content'];
  readonly className?: string;
};

export const EditorContent = ({
  initialContent,
  className,
  children,
  ...rest
}: EditorContentProps) => (
  <div className={className}>
    <EditorProvider
      content={initialContent}
      immediatelyRender={false}
      {...rest}
    >
      {children}
    </EditorProvider>
  </div>
);

interface EditorBubbleProps {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly placement?: 'top' | 'bottom';
  readonly onHidden?: () => void;
}

export const EditorBubble = ({
  children,
  className,
  placement = 'top',
  onHidden,
}: EditorBubbleProps) => {
  const { editor } = useCurrentEditor();
  const wasShown = React.useRef(false);

  if (!editor) {
    return null;
  }

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="editorBubble"
      className={className}
      options={{ placement }}
      shouldShow={({ editor: instance, state }) => {
        const show =
          instance.isEditable &&
          !state.selection.empty &&
          !instance.isActive('codeBlock');

        if (!show && wasShown.current) {
          onHidden?.();
        }
        wasShown.current = show;

        return show;
      }}
    >
      {children}
    </BubbleMenu>
  );
};

type EditorBubbleItemProps = Omit<
  React.ComponentPropsWithoutRef<'div'>,
  'onSelect'
> & {
  readonly onSelect?: (editor: Editor) => void;
};

export const EditorBubbleItem = React.forwardRef<
  HTMLDivElement,
  EditorBubbleItemProps
>(({ children, onSelect, ...rest }, ref) => {
  const { editor } = useCurrentEditor();

  if (!editor) {
    return null;
  }

  return (
    <div ref={ref} {...rest} onClick={() => onSelect?.(editor)}>
      {children}
    </div>
  );
});

EditorBubbleItem.displayName = 'EditorBubbleItem';

export interface SuggestionItem {
  title: string;
  description: string;
  icon: React.ReactNode;
  searchTerms?: string[];
  command?: (props: { editor: Editor; range: Range }) => void;
}

export const createSuggestionItems = (items: SuggestionItem[]) => items;

export const Command = Extension.create({
  name: 'slash-command',
  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: any;
        }) => {
          props.command({ editor, range });
        },
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

/** Keep arrow/enter keys inside the slash-command menu while it is open. */
export const handleCommandNavigation = (event: KeyboardEvent) => {
  if (['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
    if (document.querySelector('#slash-command')) {
      return true;
    }
  }
  return false;
};

export const getPrevText = (editor: Editor, position: number) =>
  editor.state.doc.textBetween(0, position, '\n');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiHighlight: {
      setAIHighlight: (attributes?: { color: string }) => ReturnType;
      unsetAIHighlight: () => ReturnType;
    };
  }
}

export const AIHighlight = Mark.create({
  name: 'ai-highlight',
  addOptions() {
    return { HTMLAttributes: {} };
  },
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-color') || element.style.backgroundColor,
        renderHTML: (attributes) => {
          if (!attributes.color) {
            return {};
          }
          return {
            'data-color': attributes.color,
            style: `background-color: ${attributes.color}; color: inherit`,
          };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'mark' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },
  addCommands() {
    return {
      setAIHighlight:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      unsetAIHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export const addAIHighlight = (editor: Editor, color?: string) =>
  editor
    ?.chain()
    .setAIHighlight({ color: color ?? '#c1ecf970' })
    .run();

export const removeAIHighlight = (editor: Editor) =>
  editor?.chain().unsetAIHighlight().run();
