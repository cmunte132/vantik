import type { Project } from '@vantikhq/types';

import { updateProject } from '@vantikhq/services';
import { useMutation } from '@tanstack/react-query';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: Project) => void;
  onError?: (error: string) => void;
}

export function useUpdateProjectMutation({
  onMutate,
  onSuccess,
  onError,
}: MutationParams) {
  const onMutationTriggered = () => {
    onMutate && onMutate();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMutationError = (errorResponse: any) => {
    const errorText = errorResponse?.errors?.message || 'Error occured';

    onError && onError(errorText);
  };

  const onMutationSuccess = (data: Project) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: updateProject,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess
  });
}
