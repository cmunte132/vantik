import { join } from 'path';

import { Injectable } from '@nestjs/common';
import { PluginContextFactory } from 'plugins/plugin-context.factory';
import { type PluginSpec } from 'plugins/plugin.interface';

import { LoggerService } from 'modules/logger/logger.service';

@Injectable()
export class IntegrationsService {
  private readonly logger = new LoggerService(IntegrationsService.name);

  constructor(private contextFactory: PluginContextFactory) {}

  /**
   * Runs one plugin, by the slug of its `IntegrationDefinitionV2` row.
   *
   * The context is the second argument, not the first, so that every
   * integration written against the original single-argument signature keeps
   * working while the vendors are ported one at a time. What the context is
   * *for* is that a plugin should ask the host to do things rather than reach
   * for a `PrismaClient` of its own — see `plugins/plugin.interface.ts`.
   */
  async loadIntegration(
    slug: string,
    payload: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    this.logger.info({
      message: `Loading integration ${slug}`,
      payload: { event: payload.event },
      where: 'IntegrationsService.loadIntegration',
    });

    try {
      const integrationModule = await this.importPlugin(slug);

      // Call the default function exported by the module
      if (typeof integrationModule.default === 'function') {
        // A plugin that exports a spec gets `ctx.vendor.fetch`; one that does
        // not is refused every outbound call, because the spec is where the
        // egress allowlist lives. Declaring nothing means reaching nothing.
        const ctx = this.contextFactory.build(
          slug,
          payload.workspaceId,
          payload.userId,
          integrationModule.pluginSpec,
          payload.integrationAccountId ??
            payload.integrationAccounts?.[slug]?.id,
        );

        return integrationModule.default(payload, ctx);
      }

      return undefined;
    } catch (error) {
      this.logger.error(error);
    }
  }

  /**
   * What a plugin declares about itself, read without running it.
   *
   * The host decides from this whether a record change or a webhook is the
   * plugin's business at all, before anything is queued. A slug with no plugin
   * behind it declares nothing.
   */
  async pluginSpecOf(slug: string): Promise<PluginSpec | undefined> {
    try {
      return (await this.importPlugin(slug)).pluginSpec;
    } catch (error) {
      this.logger.error({
        message: `No plugin for ${slug}: ${error}`,
        where: 'IntegrationsService.pluginSpecOf',
      });

      return undefined;
    }
  }

  /** The module in `apps/server/src/integrations/<slug>`; Node caches it. */
  private importPlugin(slug: string) {
    return import(join(__dirname, `../../integrations/${slug}`));
  }
}
