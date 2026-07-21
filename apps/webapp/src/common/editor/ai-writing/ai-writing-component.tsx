import { NodeViewWrapper } from '@tiptap/react';
import { Button } from '@vantikhq/ui/components/button';
import { Card, CardContent } from '@vantikhq/ui/components/card';
import { Markdown, useEditor } from '@vantikhq/ui/components/editor/index';
import { Loader } from '@vantikhq/ui/components/loader';
import { Skeleton } from '@vantikhq/ui/components/skeleton';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { AI, CheckLine, DeleteLine } from '@vantikhq/ui/icons';
import React from 'react';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useAIContinueWritingMutation } from 'services/issues';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AIWritingComponent = (props: any) => {
  const { editor } = useEditor();
  const [prompt, setPrompt] = React.useState('Continue writing');
  const { responses, mutate, isLoading } = useAIContinueWritingMutation({
    baseHost: '/api',
  });
  const workspace = useCurrentWorkspace();

  React.useEffect(() => {
    if (props.node.attrs.content) {
      mutate({
        description: props.node.attrs.content,
        workspaceId: workspace.id,
        userInput: prompt,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NodeViewWrapper className="ai-writing-component">
      <Card className="my-2">
        <CardContent className="p-2">
          <p className="text-sm">Preview</p>

          <Markdown>{responses}</Markdown>
          {(isLoading || !responses) && (
            <div className="flex flex-col gap-2 my-2">
              <Skeleton className="w-full h-5" />
              <Skeleton className="w-full h-5" />
              <Skeleton className="w-full h-5" />
            </div>
          )}

          <div className="flex flex-col gap-2 mt-4">
            <label className="text-sm"> Prompt </label>
            <Textarea
              value={prompt}
              className="min-h-24"
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
            <div className="flex justify-end items-center">
              <div className="flex items-center gap-2">
                {isLoading && (
                  <Loader text="Thinking..." variant="horizontal" />
                )}
                <Button
                  variant="ghost"
                  className="flex items-center gap-2"
                  onClick={() => {
                    props.deleteNode();
                  }}
                >
                  <DeleteLine size={16} />
                  Discard
                </Button>
                <Button
                  variant="ghost"
                  className="flex items-center gap-2"
                  disabled={isLoading}
                  onClick={() => {
                    props.deleteNode();
                    editor.commands.insertContent(responses);
                  }}
                >
                  <CheckLine size={16} />
                  Insert
                </Button>
                <Button
                  variant="secondary"
                  className="flex items-center gap-2"
                  disabled={isLoading}
                  onClick={() => {
                    mutate({
                      description: props.node.attrs.content,
                      workspaceId: workspace.id,
                      userInput: prompt,
                    });
                  }}
                >
                  <AI size={16} />
                  Regenerate
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </NodeViewWrapper>
  );
};
