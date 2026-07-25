import axios from 'axios';

export interface RevokeAgentDto {
  agentId: string;
}

export async function revokeAgent({ agentId }: RevokeAgentDto): Promise<void> {
  await axios.post(`/api/v1/users/agents/${agentId}/revoke`);
}
