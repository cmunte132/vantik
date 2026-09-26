import { RiSendPlaneLine } from '@remixicon/react';
import { AvatarText } from '@vantikhq/ui/components/avatar';
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

import { UserContext } from 'store/user-context';

import { FileUpload } from '../../file-upload';

interface ReplyCommentProps {
  issueCommentId: string;
}

export function ReplyComment({ issueCommentId }: ReplyCommentProps) {
  const currentUser = React.useContext(UserContext);
  const issueData = useIssueData();
  const [commentValue, setCommentValue] = React.useState('');
  const { mutate: createIssueComment } = useCreateIssueCommentMutation({});
  const suggestion = useMentionSuggestions();
  const { toast } = useToast();

  // Nothing autosaves a reply: until it is submitted this component holds the
  // only copy, so an auto-reload has to wait.
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
        parentId: issueCommentId,
      });
    }

    setCommentValue(undefined);
  };

  return (
    <div className="flex items-start w-full border-t border-border px-2 py-2 pb-0 !mt-0">
      <AvatarText text={currentUser.fullname} className="text-[9px]" />

      <div className="w-full relative">
        <Editor
          placeholder="Leave a reply..."
          value={commentValue}
          extensions={[
            CustomMention.configure({
              suggestion,
            }),
          ]}
          autoFocus
          onSubmit={onSubmit}
          onCreate={(editor) => {
            editorRef.current = editor;
          }}
          onChange={(e) => setCommentValue(e)}
          className="w-full min-h-[60px] bg-transparent mb-0 p-2 pt-0 grow text-foreground relative"
        >
          <div className="absolute right-1 bottom-1 flex items-center">
            <FileUpload withPosition={false} />

            <Button
              variant="ghost"
              className="transition-all duration-500 ease-in-out my-2"
              type="submit"
              size="sm"
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
