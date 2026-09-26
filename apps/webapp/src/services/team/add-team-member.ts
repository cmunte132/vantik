import { addTeamMember } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useAddTeamMemberMutation = mutationHook(addTeamMember);
