import { useRouter } from 'common/router';

import { useContextStore } from 'store/global-context-provider';

export const useProject = () => {
  const {
    query: { projectId },
  } = useRouter();
  const { projectsStore } = useContextStore();

  return projectsStore.getProjectWithId(projectId);
};
