import { ActionTypesEnum } from '@vantikhq/types';
import {
  type PluginContext,
  type PluginSpec,
} from 'plugins/plugin.interface';

import { convertMarkdownToTiptapJson } from 'common/utils/tiptap.utils';

import { PARTIAL_SOLUTION_PROMPT } from './prompt';

/**
 * A plugin with no vendor.
 *
 * This is the case that says the action/integration split was never about what
 * the code is. `bug-enricher` declares `"integrations": []` in its config — it
 * talks to no third party at all. It watches for an issue labelled `bug` and
 * asks the deployment's own model for a resolution guide.
 *
 * It stays a plugin rather than becoming an "Automation", because inventing a
 * second concept for a population of one buys nothing: the trigger engine, the
 * dispatch and the capabilities are identical, and the only difference is an
 * empty `egress`. If in-app automation rules ever become a product goal, that
 * is a feature built on this engine and not a reason to fork the model now.
 * See ENG-89, stage 4.
 */
export const pluginSpec: PluginSpec = {
  slug: 'bug-enricher',
  // No vendor, so nothing to reach. An empty allowlist is not an oversight
  // here — `ctx.vendor.fetch` refuses every call, which is correct.
  egress: [],
};

export default async function run(
  eventPayload: { event: string; modelId?: string },
  ctx: PluginContext,
) {
  switch (eventPayload.event) {
    case ActionTypesEnum.ON_CREATE:
      return await enrich(ctx, eventPayload.modelId);

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}

async function enrich(ctx: PluginContext, issueId?: string) {
  if (!issueId) {
    return null;
  }

  const issue = await ctx.issues.get(issueId);

  if (!issue?.labelIds?.length) {
    return null;
  }

  const labels = await ctx.workspace.labels();
  const named = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labels.map((label: any) => [label.id, String(label.name).toLowerCase()]),
  );

  // Only bugs. Enriching every issue would put a wall of generated text on work
  // that never asked for one.
  const isBug = issue.labelIds.some(
    (labelId: string) => named.get(labelId) === 'bug',
  );

  if (!isBug) {
    return null;
  }

  const answer = await ctx.ai.request({
    messages: [
      { role: 'system', content: PARTIAL_SOLUTION_PROMPT },
      {
        role: 'user',
        content: `[INPUT] bug_description: ${issue.description ?? ''}`,
      },
    ],
    llmModel: 'fast',
    model: 'BugSuggestion',
  });

  // The prompt asks for the guide after an `[OUTPUT]` marker. Without it the
  // model answered something other than what was asked, and posting that as a
  // comment is worse than posting nothing.
  const match = /\[OUTPUT\]\s*([\s\S]*)/.exec(String(answer ?? ''));

  if (!match?.[1]) {
    ctx.log.debug(`No suggestion for issue ${issueId}`);

    return null;
  }

  return await ctx.comments.create({
    issueId,
    body: convertMarkdownToTiptapJson(match[1]),
  });
}
