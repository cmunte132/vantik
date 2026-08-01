import type { Editor, Range } from '@tiptap/core';

import { RiListCheck3 } from '@remixicon/react';
import { suggestionItems } from '@vantikhq/ui/components/editor/slash-command';
import React from 'react';

export const useEditorSuggestionItems = () => {
  const appendedSuggestionItems = React.useMemo(() => {
    return [
      {
        title: 'Continue writing',
        description: 'Continue writing the description',
        searchTerms: ['continue', 'writing'],
        icon: <RiListCheck3 size={18} className="text-purple-500" />,

        command: ({ editor, range }: { editor: Editor; range: Range }) => {
          const description = editor.getText();
          if (description) {
            editor
              ?.chain()
              .focus()
              .deleteRange(range)
              .createAIWritingNode(description)
              .run();
          }
        },
      },
      ...suggestionItems,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { suggestionItems: appendedSuggestionItems };
};
