import axios from 'axios';

/**
 * Stops the automatic cadence. Upcoming cycles are removed and their issues
 * detached; the running cycle is left to finish.
 */
export async function stopCycles({
  teamId,
}: {
  teamId: string;
}): Promise<{ removed: number }> {
  const response = await axios.post('/api/v1/cycles/stop', { teamId });

  return response.data;
}
