import { removeTeamMember } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useRemoveTeamMemberMutation = mutationHook(removeTeamMember);
