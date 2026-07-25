import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { VantikAgent, VantikClient } from '@vantikhq/agent-core';
import { Request, Response } from 'express';

import { bearerToken } from 'common/pat-session';

import { SkipAgentScope } from 'modules/auth/agent-scope';
import { AuthGuard } from 'modules/auth/auth.guard';
import { LoggerService } from 'modules/logger/logger.service';

import { McpThrottleGuard } from './mcp-throttle.guard';
import { registerVantikTools } from './mcp.tools';

const SERVER_INFO = { name: 'vantik', version: '0.1.0' };

/**
 * Streamable HTTP MCP endpoint.
 *
 * Stateless by design: every request gets its own server and transport, so
 * there is no session state to expire, pin to a process, or replicate across
 * replicas. The caller's PAT is taken from the Authorization header and used
 * for the REST calls agent-core makes, which means MCP callers get exactly the
 * permissions their token already has — no separate authorisation path to keep
 * in sync.
 *
 * AuthGuard still runs first, even though the loopback calls are what actually
 * enforce anything. Without it an unauthenticated caller could hand over any
 * string and still have a server spun up for it, list every tool, and — because
 * the rate limit counts the token — get a fresh budget for each string it
 * invented. Rejecting an unknown token up front closes both.
 *
 * Requests are rate limited per token, so one agent stuck in a loop cannot
 * starve the others.
 *
 * Agent scopes are checked on the loopback calls rather than here: one POST
 * carries every tool, read-only ones included, so the method says nothing about
 * what the request will do.
 */
@SkipAgentScope()
@Controller({ version: '1', path: 'mcp' })
export class McpController {
  private readonly logger: LoggerService = new LoggerService('McpController');

  @UseGuards(AuthGuard, McpThrottleGuard)
  @Post()
  async handleRequest(@Req() request: Request, @Res() response: Response) {
    const token = this.extractToken(request);

    const agent = new VantikAgent(
      new VantikClient({ baseUrl: this.loopbackUrl(), token }),
    );

    const server = new McpServer(SERVER_INFO);
    registerVantikTools(server, agent);

    const transport = new StreamableHTTPServerTransport({
      // Stateless mode: no session ids, no server-side session store.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    response.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      this.logger.error({
        message: `MCP request failed: ${(error as Error).message}`,
        where: 'McpController.handleRequest',
        error: error as Error,
      });

      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  /**
   * Stateless servers have no stream to resume and no session to delete; the
   * spec expects 405 rather than a silent 404 from the router.
   */
  @Get()
  handleGet(@Res() response: Response) {
    this.methodNotAllowed(response);
  }

  @Delete()
  handleDelete(@Res() response: Response) {
    this.methodNotAllowed(response);
  }

  private methodNotAllowed(response: Response) {
    response.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'This MCP server is stateless; use POST for every request.',
      },
      id: null,
    });
  }

  private extractToken(request: Request): string {
    const token = bearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException(
        'Missing personal access token. Send it as "Authorization: Bearer tg_pat_…".',
      );
    }

    return token;
  }

  /**
   * MCP tools reach the API over loopback rather than calling services
   * directly, so tenancy, validation and the semantic layer stay in exactly one
   * place. The extra hop is a local request and costs about a millisecond.
   */
  private loopbackUrl(): string {
    return (
      process.env.MCP_LOOPBACK_URL ??
      `http://127.0.0.1:${process.env.PORT || 3001}`
    );
  }
}
