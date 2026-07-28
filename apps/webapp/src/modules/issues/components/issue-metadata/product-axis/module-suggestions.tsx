import { Button } from '@vantikhq/ui/components/button';
import { CheckLine, CrossLine } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { isArchived } from 'modules/product-axis/archive';
import { AxisIcon } from 'modules/product-axis/axis-icon';

import type { ModuleType } from 'common/types';

import {
  useAcceptModuleSuggestionMutation,
  useDismissModuleSuggestionMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

/**
 * The modules the classifier proposes for an issue.
 *
 * A suggestion is the least confident of the three tiers that fill in a module:
 * the classifier proposes, a pull request assigns from the files it changed,
 * and a person overrules both. So it is drawn as something not yet true — a
 * dashed outline, dimmed — beside the modules that are.
 *
 * Accepting is a human act, and it promotes the module to the top tier.
 * Dismissing costs nothing and is remembered, so the same module does not come
 * back on the next run.
 */
export const ModuleSuggestions = observer(
  ({ issueId, moduleIds }: { issueId: string; moduleIds: string[] }) => {
    const { issueSuggestionsStore, modulesStore } = useContextStore();

    const { mutate: accept } = useAcceptModuleSuggestionMutation({});
    const { mutate: dismiss } = useDismissModuleSuggestionMutation({});

    const suggestion =
      issueSuggestionsStore.getIssueSuggestionsForIssue(issueId);

    const suggested: ModuleType[] = (suggestion?.suggestedModuleIds ?? [])
      .map((moduleId: string) => modulesStore.getModuleWithId(moduleId))
      .filter(Boolean)
      // A module the issue already names is not a suggestion, and an archived
      // one is not work to start. Neither is worth a chip.
      .filter(
        (module: ModuleType) =>
          !moduleIds.includes(module.id) && !isArchived(module),
      );

    if (suggested.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col items-start gap-1">
        <div className="text-xs text-left text-muted-foreground">Suggested</div>

        <div className="flex flex-wrap gap-1">
          {suggested.map((module: ModuleType) => (
            <span
              key={module.id}
              data-suggested-module={module.id}
              className="flex items-center gap-1 rounded-md border border-dashed
                border-border px-1.5 py-0.5 text-muted-foreground opacity-80"
            >
              <AxisIcon
                kind="module"
                name={module.name}
                icon={module.icon}
                color={module.color}
                size="xs"
                className="opacity-70"
              />
              <span className="truncate">{module.name}</span>

              <Button
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0"
                aria-label={`Accept ${module.name}`}
                onClick={() => accept({ issueId, moduleId: module.id })}
              >
                <CheckLine size={12} />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0"
                aria-label={`Dismiss ${module.name}`}
                onClick={() => dismiss({ issueId, moduleId: module.id })}
              >
                <CrossLine size={12} />
              </Button>
            </span>
          ))}
        </div>
      </div>
    );
  },
);
