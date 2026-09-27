import { loopbackClientConfig } from './mcp.controller';

/**
 * The MCP endpoint is stateless, so the protocol never says which harness
 * session a call came from. A harness that wants the knowledge it is served
 * traced to its session names it in a header, and the tools pass it on.
 */
describe('the client the MCP tools call the API with', () => {
  it("[KG-3.1] carries the caller's token and harness session", () => {
    expect(
      loopbackClientConfig(
        { headers: { 'x-vantik-session': 'claude-session-42' } },
        'tg_pat_agent',
        'http://127.0.0.1:3001',
      ),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:3001',
      token: 'tg_pat_agent',
      sessionId: 'claude-session-42',
    });
  });

  it('[KG-3.1] carries no session when none, or no usable one, was named', () => {
    for (const headers of [{}, { 'x-vantik-session': 'not one\tvalue' }]) {
      expect(
        loopbackClientConfig({ headers }, 'tg_pat_agent', 'http://x').sessionId,
      ).toBeUndefined();
    }
  });
});
