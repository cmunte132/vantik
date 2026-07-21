import { Editor } from '@tiptap/core';
import { UserTypeEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { defaultExtensions } from '@vantikhq/ui/components/editor/editor-extensions';
import { AI } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import React, { useEffect, useRef } from 'react';

import type { ConversationHistoryType } from 'common/types';
import { UserAvatar } from 'common/user-avatar';

import { useUserData } from 'hooks/users';
import { useCurrentWorkspace } from 'hooks/workspace';

import { useRunTasksMutation } from 'services/conversations';

interface AIConversationItemProps {
  conversationHistory: ConversationHistoryType;
}

export const ConversationItem = observer(
  ({ conversationHistory }: AIConversationItemProps) => {
    const { user } = useUserData(conversationHistory.userId);
    const id = `a${conversationHistory.id.replace(/-/g, '')}`;
    const editorRef = useRef<Editor | null>(null);
    const { mutate: runTasks } = useRunTasksMutation({});
    const workspace = useCurrentWorkspace();

    useEffect(() => {
      const element = document.getElementById(id);
      let editor: Editor;

      if (element) {
        editor = new Editor({
          element,
          extensions: defaultExtensions,
          editable: false,
        });
        editorRef.current = editor;

        editor.commands.setContent(conversationHistory.message, {
          emitUpdate: false,
          parseOptions: { preserveWhitespace: true },
        });
      }
      // Clean up on unmount
      return () => {
        editor && editor.destroy();
      };
    }, [id, conversationHistory.message]);

    const thoughts = JSON.parse(conversationHistory.thoughts);

    const pendingTasks = thoughts ?? thoughts?.pendingTasks ?? [];

    const getIcon = () => {
      if (conversationHistory.userType === UserTypeEnum.User) {
        return <UserAvatar user={user} />;
      }

      return <AI size={16} />;
    };

    return (
      <div className="flex gap-2 border-b border-border py-4 px-5">
        <div className="shrink-0">{getIcon()}</div>

        <div className="flex flex-col">
          <div id={id}></div>
          {pendingTasks && pendingTasks.length > 0 && (
            <div className="flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  runTasks({
                    baseHost: '/api',
                    conversationId: conversationHistory.conversationId,
                    conversationHistoryId: conversationHistory.id,
                    workspaceId: workspace.id,
                    taskIds: [],
                  });
                }}
              >
                Execute all
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  },
);
