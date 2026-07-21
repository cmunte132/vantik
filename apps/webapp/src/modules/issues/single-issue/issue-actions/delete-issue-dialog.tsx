import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogHeader,
  AlertDialogFooter,
} from '@vantikhq/ui/components/alert-dialog';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { useRouter } from 'next/router';
import React from 'react';

import type { IssueType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';

import { useDeleteIssueMutation } from 'services/issues';

interface DeleteIssueDialogProps {
  deleteIssueDialog: boolean;
  setDeleteIssueDialog: (value: boolean) => void;
  issue: IssueType;
}

export function DeleteIssueDialog({
  deleteIssueDialog,
  setDeleteIssueDialog,
  issue,
}: DeleteIssueDialogProps) {
  const { toast } = useToast();
  const currentTeam = useCurrentTeam();
  const {
    query: { workspaceSlug },
    push,
  } = useRouter();

  // Navigating away before the request lands hides its outcome: a failed
  // delete looked exactly like a successful one, with the issue still there.
  const { mutate: deleteIssue } = useDeleteIssueMutation({
    onSuccess: () => {
      setDeleteIssueDialog(false);
      push(`/${workspaceSlug}/team/${currentTeam.identifier}/all`);
    },
    onError: (error: string) => {
      setDeleteIssueDialog(false);
      toast({
        title: 'Could not delete the issue',
        description: error,
      });
    },
  });

  const onDeleteIssue = () => {
    deleteIssue({ issueId: issue.id, teamId: currentTeam.id });
  };

  return (
    <AlertDialog open={deleteIssueDialog} onOpenChange={setDeleteIssueDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently remove this the
            issue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDeleteIssue}>
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
