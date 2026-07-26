import type { Editor, Range } from '@tiptap/core';
import type { UseFieldArrayReturn } from 'react-hook-form';

import { suggestionItems } from '@vantikhq/ui/components/editor/slash-command';
import { ListEdit, SubIssue } from '@vantikhq/ui/icons';
import React from 'react';

import { useAIEnabled } from 'hooks';
import { useCurrentWorkspace } from 'hooks/workspace';

import { useSubIssueGenerationMutation } from 'services/issues';

export const useSuggestionItems = (
  subIssueOperations: Partial<UseFieldArrayReturn>,
) => {
  const workspace = useCurrentWorkspace();
  const aiEnabled = useAIEnabled();
  const { mutate: generateSubIssues, isPending: isLoading } =
    useSubIssueGenerationMutation({
      onSuccess: (data: string[]) => {
        if (data && data.length > 0) {
          data.forEach((issueTitle: string) => {
            subIssueOperations.append({
              title: issueTitle,
              description: JSON.stringify({
                json: {
                  type: 'doc',
                  content: [
                    {
                      type: 'aiWritingExtension',
                      attrs: {
                        content: issueTitle,
                      },
                    },
                  ],
                },
              }),
            });
          });
        }
      },
    });

  const appendedSuggestionItems = React.useMemo(() => {
    // Without an LLM endpoint the slash menu is the plain editor one. Both of
    // the items below reach the AI request path, so offering them would only
    // produce a failure a keystroke later.
    if (!aiEnabled) {
      return suggestionItems;
    }

    return [
      {
        title: 'Break into sub-issues',
        description: 'Break into sub issues',
        searchTerms: ['sub-issues', 'issues'],
        icon: <SubIssue size={18} className="text-purple-500" />,
        command: ({ editor, range }: { editor: Editor; range: Range }) => {
          const description = editor.getText();
          if (description) {
            generateSubIssues({ description, workspaceId: workspace.id });
            editor.chain().focus().deleteRange(range).run();
          }
        },
      },
      {
        title: 'Continue writing',
        description: 'Continue writing the description',
        searchTerms: ['continue', 'writing'],
        icon: <ListEdit size={18} className="text-purple-500" />,
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
  }, [aiEnabled, generateSubIssues, workspace.id]);

  return { suggestionItems: appendedSuggestionItems, isLoading };
};
