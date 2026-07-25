import axios from 'axios';

export interface RevokeAgentDto {
  agentId: string;
  workspaceId: string;
}

export async function revokeAgent({
  agentId,
  workspaceId,
}: RevokeAgentDto): Promise<void> {
  await axios.post(
    `/api/v1/users/agents/${agentId}/revoke?workspaceId=${workspaceId}`,
  );
}
