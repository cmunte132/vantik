import { WorkflowCategoryEnum } from '@vantikhq/types';
import { Editor, EditorExtensions } from '@vantikhq/ui/components/editor/index';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { Separator } from '@vantikhq/ui/components/separator';
import { observer } from 'mobx-react-lite';
import * as React from 'react';
import { useDebouncedCallback } from 'use-debounce';

import { useEditorSuggestionItems } from 'modules/issues/components/use-editor-suggestion-items';

import { getTiptapJSON } from 'common';
import { vantikIssueExtension } from 'common/editor/vantik-issue-extension';
import { type WorkflowType } from 'common/types';

import { useIssueData } from 'hooks/issues';
import { useTeamWithId } from 'hooks/teams';
import { useEditorPasteHandler } from 'hooks/use-editor-paste-handler';
import { useTeamWorkflows } from 'hooks/workflows';

import { useUpdateIssueMutation } from 'services/issues';

import { Activity } from './activity';
import { ChecklistView } from './checklist-view';
import { FileUpload } from './file-upload';
import { IssueSubIssueSelector } from './issue-sub-issue-selector';
import { IssueTitle } from './issue-title';
import { ParentIssueView } from './parent-issue-view';
import { RelationsView } from './relations-view';
import { SimilarIssuesView } from './similar-issues-view';
import { SubIssueView } from './sub-issue-view';

export const LeftSide = observer(() => {
  const issue = useIssueData();
  const team = useTeamWithId(issue.teamId);

  const workflows = useTeamWorkflows(team.identifier);
  const triageWorkflow = workflows.find(
    (workflow: WorkflowType) =>
      workflow.category === WorkflowCategoryEnum.TRIAGE,
  );
  const isTriageView = issue.stateId === triageWorkflow?.id;

  const { mutate: updateIssue } = useUpdateIssueMutation({});
  const { suggestionItems } = useEditorSuggestionItems();

  // Each save waits a second after the last keystroke. What is still waiting
  // when the sheet closes, or moves to another issue, is sent then rather than
  // dropped. The issue travels with the text, not read off `issue` when the
  // timer fires: the sheet renders the next issue before it lets this one go,
  // and a late save would otherwise land in the issue just opened.
  const onDescriptionChange = useDebouncedCallback(
    (id: string, teamId: string, content: string) => {
      const { json: description } = getTiptapJSON(content);

      updateIssue({ description: JSON.stringify(description), teamId, id });
    },
    1000,
    { flushOnExit: true },
  );

  const onIssueChange = useDebouncedCallback(
    (id: string, teamId: string, title: string) => {
      updateIssue({ title, teamId, id });
    },
    1000,
    { flushOnExit: true },
  );

  const { handlePaste } = useEditorPasteHandler();

  // The scroll frame is not a flex container. It used to centre its own
  // viewport, and a viewport cannot shrink below the width of the widest code
  // block it holds, so a narrow column pushed the text out of both sides of the
  // frame and `overflow-hidden` cut it off. min-w-0 lets every box shrink, and
  // mx-auto does the centring the layout wanted.
  return (
    <ScrollArea className="grow h-full w-full min-w-0">
      <div className="flex h-full w-full min-w-0 pb-[150px]">
        <div className="grow min-w-0 mx-auto flex flex-col gap-2 h-full max-w-[97ch]">
          <div className="py-6 flex flex-col">
            {isTriageView && <SimilarIssuesView issueId={issue.id} />}

            {/* Keyed on the issue, so each only ever reports edits to its own.
                The two keys differ: siblings that shared one left React unable
                to tell them apart, and every update to the issue drew another
                title above the last. */}
            <IssueTitle
              key={`${issue.id}-title`}
              value={issue.title}
              onChange={(title) => onIssueChange(issue.id, issue.teamId, title)}
            />
            {issue.parentId && (
              <div className="px-6">
                <ParentIssueView issue={issue} />
              </div>
            )}
            <Editor
              key={`${issue.id}-description`}
              value={issue.description}
              onChange={(content: string) =>
                onDescriptionChange(issue.id, issue.teamId, content)
              }
              handlePaste={handlePaste}
              extensions={[vantikIssueExtension]}
              className="min-h-[50px] mb-8 px-6 mt-3 text-md"
            >
              <FileUpload />
              <EditorExtensions suggestionItems={suggestionItems}>
                <IssueSubIssueSelector />
              </EditorExtensions>
            </Editor>

            <div className="mx-6">
              <Separator />
            </div>
            <ChecklistView issueId={issue.id} />

            <SubIssueView childIssues={issue.children} issueId={issue.id} />

            <RelationsView issueId={issue.id} />

            <Activity />
          </div>
        </div>
      </div>
    </ScrollArea>
  );
});
