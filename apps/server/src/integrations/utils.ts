import { CreateIntegrationAccountDto } from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

/**
 * Stores a connected account, through the host rather than a client of our own.
 *
 * This took a `PrismaClient`, and every caller supplied one it had constructed
 * at module scope. That is precisely the shape the plugin contract exists to
 * remove: a boundary drawn around code that can open its own database
 * connection buys crash containment and nothing else. See
 * `plugins/plugin.interface.ts`.
 */
export async function createIntegrationAccount(
  ctx: PluginContext,
  createIntegrationAccountDto: CreateIntegrationAccountDto,
) {
  return await ctx.account.upsert(createIntegrationAccountDto);
}
