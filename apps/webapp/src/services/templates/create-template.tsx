import type { Template } from '@vantikhq/types';

import { createTemplate } from '@vantikhq/services';
import { useMutation } from '@tanstack/react-query';

export interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: Template) => void;
  onError?: (error: string) => void;
}

export function useCreateTemplateMutation({
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

  const onMutationSuccess = (data: Template) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: createTemplate,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess
  });
}
