import { RiSendPlaneLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Editor,
  EditorExtensions,
  type EditorT,
  suggestionItems,
} from '@vantikhq/ui/components/editor/index';
import { useToast } from '@vantikhq/ui/components/use-toast';
import * as React from 'react';

import {
  CustomMention,
  pendingUploads,
  useMentionSuggestions,
} from 'components/editor';
import { useIssueData } from 'hooks/issues';
import { useReloadBlock } from 'hooks/use-reload-block';

import { useCreateIssueCommentMutation } from 'services/issues';

import { FileUpload } from '../../file-upload';

export function IssueComment() {
  const issueData = useIssueData();
  const [commentValue, setCommentValue] = React.useState('');
  const { mutate: createIssueComment } = useCreateIssueCommentMutation({});
  const suggestion = useMentionSuggestions();
  const { toast } = useToast();

  // A half-written comment lives only in this component, so an auto-reload
  // would throw it away. Unlike the issue description, nothing autosaves it.
  //
  // Truthiness, not `!== ''`: submitting resets the editor with `undefined`,
  // which is not the empty string, so the stricter test held the block for as
  // long as the view stayed mounted and no silent reload could ever happen
  // again on a client that had posted once.
  useReloadBlock(!!commentValue);

  const editorRef = React.useRef<EditorT>(undefined);

  // What the editor holds now, not `commentValue`: that trails the editor by
  // half a second, and a comment sent inside that half second was cleared
  // without being posted.
  const onSubmit = () => {
    const editor = editorRef.current;
    const json = editor?.getJSON();
    const text = editor?.getText();

    if (json && pendingUploads(json)) {
      toast({
        title: 'Uploads pending!',
        variant: 'destructive',
        description: 'Some uploads are pending, please wait before you comment',
      });

      return;
    }

    if (text) {
      createIssueComment({
        body: JSON.stringify(json),
        issueId: issueData.id,
      });
    }

    setCommentValue(undefined);
  };

  return (
    <div className="flex items-start w-full">
      <div className="w-full ">
        <Editor
          value={commentValue}
          onChange={(e) => {
            setCommentValue(e);
          }}
          extensions={[
            CustomMention.configure({
              suggestion,
            }),
          ]}
          placeholder="Leave your comment..."
          onSubmit={onSubmit}
          onCreate={(editor) => {
            editorRef.current = editor;
          }}
          className="w-full min-h-[60px] mb-0 p-2 border-border border relative"
        >
          <div className="absolute right-1 bottom-1 flex items-center gap-1">
            <FileUpload withPosition={false} />
            <Button
              variant="ghost"
              type="submit"
              aria-label="Send comment"
              onClick={onSubmit}
            >
              <RiSendPlaneLine size={20} />
            </Button>
          </div>
          <EditorExtensions suggestionItems={suggestionItems} />
        </Editor>
      </div>
    </div>
  );
}
