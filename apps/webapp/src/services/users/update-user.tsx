import { ajaxPut, mutationHook } from 'services/utils';

export interface UpdateUserParams {
  fullname: string;
  username: string;
}

function updateUser({ fullname, username }: UpdateUserParams) {
  return ajaxPut({
    url: `/api/v1/users`,
    data: {
      fullname,
      username,
    },
  });
}

export const useUpdateUserMutation = mutationHook(updateUser);
