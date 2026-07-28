import { Logger } from '@nestjs/common';
import { CreateIssueDto, UpdateIssueDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import AIRequestsService from 'modules/ai-requests/ai-requests.services';
import { isLLMConfigured } from 'modules/ai-requests/llm-provider';

const logger = new Logger('IssuesAIUtils');

export async function getIssueTitle(
  prisma: PrismaService,
  aiRequestsService: AIRequestsService,
  issueData: CreateIssueDto | UpdateIssueDto,
  workspaceId: string,
): Promise<string> {
  if (issueData.title) {
    return issueData.title;
    // This one is not an AI feature the caller opted into — it sits on the
    // ordinary create-issue path. An install with no LLM endpoint must still be
    // able to create issues, so it gets an empty title, not an error.
  } else if (issueData.description && isLLMConfigured()) {
    const titlePrompt = await prisma.prompt.findFirst({
      where: { name: 'IssueTitle', workspaceId },
    });
    return await aiRequestsService.getLLMRequest(
      {
        messages: [
          { role: 'system', content: titlePrompt.prompt },
          { role: 'user', content: issueData.description },
        ],
        llmModel: titlePrompt.model,
        model: 'IssueTitle',
      },
      workspaceId,
    );
  }
  return '';
}

export async function getAiFilter(
  prisma: PrismaService,
  aiRequestsService: AIRequestsService,
  filterText: string,
  filterData: Record<string, string[]>,
  workspaceId: string,
) {
  const aiFilterPrompt = await prisma.prompt.findFirst({
    where: { name: 'Filter', workspaceId },
  });
  const filterPrompt = aiFilterPrompt.prompt
    .replace('{{status}}', filterData.workflowNames.join(', '))
    .replace('{{assignee}}', filterData.assigneeNames.join(', '))
    .replace('{{label}}', filterData.labelNames.join(', '));

  try {
    const response = await aiRequestsService.getLLMRequest(
      {
        messages: [
          { role: 'system', content: filterPrompt },
          { role: 'user', content: filterText },
        ],
        llmModel: aiFilterPrompt.model,
        model: 'AIFilters',
      },
      workspaceId,
    );
    return JSON.parse(response);
  } catch (error) {
    // An empty filter matches everything, so a silent {} looks to the caller
    // like the model simply found nothing to constrain on.
    logger.error(
      `AI filter generation failed, returning an empty filter: ${error.message}`,
      error.stack,
    );
    return {};
  }
}

/** A module, as the classifier sees it. */
export interface ClassifiableModule {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * This function asks the model which modules an issue would change.
 *
 * It returns the ids of the modules that the model named. A name the model
 * invented reaches no module and is dropped, so the caller never gets an id it
 * cannot resolve.
 *
 * The answer is a suggestion. Nothing here writes to the issue.
 */
export async function getSuggestedModules(
  prisma: PrismaService,
  aiRequestsService: AIRequestsService,
  modules: ClassifiableModule[],
  description: string,
  workspaceId: string,
): Promise<string[]> {
  // A workspace that has drawn no modules has nothing to choose from, and a
  // deployment with no model configured answers nothing. Neither is a fault.
  if (!isLLMConfigured() || modules.length === 0 || !description) {
    return [];
  }

  const prompt = await prisma.prompt.findUnique({
    where: { name_workspaceId: { name: 'ModuleClassifier', workspaceId } },
  });

  // The prompt row is seeded at each start of the server. A workspace made in
  // the seconds before that finishes has none, and a suggestion is not worth
  // an error.
  if (!prompt) {
    return [];
  }

  const answer = await aiRequestsService.getLLMRequest(
    {
      messages: [
        { role: 'system', content: prompt.prompt },
        {
          role: 'user',
          content: `Text Description - ${description}\n Modules -\n${modules
            .map(
              (module) =>
                `${module.name}: ${module.description ?? 'no description'}`,
            )
            .join('\n')}`,
        },
      ],
      llmModel: prompt.model,
      model: 'ModuleSuggestion',
    },
    workspaceId,
  );

  return matchModuleNames(answer, modules);
}

/**
 * This function turns the answer of the model into module ids.
 *
 * The model returns names, and it returns them in whatever case and spacing it
 * chose. A name that matches no module is dropped rather than guessed at: the
 * model inventing "Frontend" for a workspace that has no such module must add
 * nothing to the issue.
 */
export function matchModuleNames(
  answer: string | null | undefined,
  modules: ClassifiableModule[],
): string[] {
  if (!answer) {
    return [];
  }

  const byName = new Map(
    modules.map((module) => [module.name.trim().toLowerCase(), module.id]),
  );

  const ids = answer
    .split(/[,\n]/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .map((name) => byName.get(name))
    .filter(Boolean) as string[];

  return [...new Set(ids)];
}

export async function getSuggestedLabels(
  prisma: PrismaService,
  aiRequestsService: AIRequestsService,
  labels: string[],
  description: string,
  workspaceId: string,
) {
  // The suggestions endpoint also returns assignees, which come from vector
  // search and need no LLM. Returning no labels leaves that half working
  // instead of failing the whole response.
  if (!isLLMConfigured()) {
    return '';
  }

  const labelPrompt = await prisma.prompt.findUnique({
    where: { name_workspaceId: { name: 'IssueLabels', workspaceId } },
  });
  return await aiRequestsService.getLLMRequest(
    {
      messages: [
        { role: 'system', content: labelPrompt.prompt },
        {
          role: 'user',
          content: `Text Description  -  ${description} \n Company Specific Labels -  ${labels.join(',')}`,
        },
      ],
      llmModel: labelPrompt.model,
      model: 'LabelSuggestion',
    },
    workspaceId,
  );
}

export async function getSummary(
  prisma: PrismaService,
  aiRequestsService: AIRequestsService,
  conversations: string,
  workspaceId: string,
) {
  const summarizePrompt = await prisma.prompt.findFirst({
    where: { name: 'IssueSummary', workspaceId },
  });
  return await aiRequestsService.getLLMRequest(
    {
      messages: [
        { role: 'system', content: summarizePrompt.prompt },
        {
          role: 'user',
          content: `[INPUT] conversations: ${conversations}`,
        },
      ],
      llmModel: summarizePrompt.model,
      model: 'IssueSummary',
    },
    workspaceId,
  );
}

/** The key that holds the dismissed modules inside `IssueSuggestion.metadata`. */
export const DISMISSED_MODULES_KEY = 'dismissedModuleIds';

/**
 * This function reads the modules a person dismissed on an issue.
 *
 * The list lives in `IssueSuggestion.metadata`, which is a free Json column, so
 * it needs no migration and no field of its own. A row written before this
 * feature has no key, and an older row can hold anything, so every shape that
 * is not a list of strings reads as an empty list.
 */
export function dismissedModuleIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  const value = (metadata as Record<string, unknown>)[DISMISSED_MODULES_KEY];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((id): id is string => typeof id === 'string');
}

/**
 * This function returns the metadata to write when a person dismisses a module.
 *
 * It keeps every other key of the metadata, because this column belongs to more
 * than this feature.
 */
export function withDismissedModule(
  metadata: unknown,
  moduleId: string,
): Record<string, unknown> {
  const existing =
    metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>)
      : {};

  return {
    ...existing,
    [DISMISSED_MODULES_KEY]: [
      ...new Set([...dismissedModuleIds(metadata), moduleId]),
    ],
  };
}
