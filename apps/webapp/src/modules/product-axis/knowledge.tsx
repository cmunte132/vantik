import { Badge } from '@vantikhq/ui/components/badge';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';

import type { ModuleType } from 'common/types';

import { useModuleKnowledge, useRelatedPages } from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { knowledgeModuleIds, type KnowledgeTarget } from './knowledge-scope';

const KIND_LABEL: Record<string, string> = {
  FACT: 'Fact',
  DECISION: 'Decision',
  CONVENTION: 'Convention',
  GOTCHA: 'Gotcha',
};

const NOUN: Record<KnowledgeTarget['type'], string> = {
  PRODUCT: 'product',
  MODULE: 'module',
  CAPABILITY: 'capability',
};

/**
 * What the workspace knows about this product, module or capability.
 *
 * Two halves. The pages linked to it are the documentation someone decided is
 * about it. The standing facts are what agents and people established about
 * its code, found by where each fact is scoped rather than by anyone linking
 * it — which is why they appear here without anybody having filed them.
 */
export const Knowledge = observer(({ target }: { target: KnowledgeTarget }) => {
  const { modulesStore } = useContextStore();
  const router = useRouter();
  const { workspaceSlug } = router.query;

  const moduleIds = knowledgeModuleIds(
    target,
    modulesStore.getModules as ModuleType[],
  );
  const { data: pages } = useRelatedPages(target.type, target.id);
  const { data: entries } = useModuleKnowledge(moduleIds);

  const openPage = (pageId: string) =>
    router.push({
      pathname: '/[workspaceSlug]/pages/[pageId]',
      query: { workspaceSlug, pageId },
    });

  return (
    <div className="flex flex-col divide-y divide-border">
      <div className="flex flex-col gap-1 px-4 py-3">
        <span className="text-muted-foreground">Pages</span>
        {pages?.length ? (
          pages.map((page) => (
            <button
              key={page.linkId}
              type="button"
              className="truncate text-left hover:underline"
              onClick={() => openPage(page.id)}
            >
              {page.title || 'Untitled page'}
            </button>
          ))
        ) : (
          <p className="text-muted-foreground">
            No page is linked to this {NOUN[target.type]} yet. Link one from the
            Related section at the foot of any knowledge page.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        <span className="text-muted-foreground">Standing facts</span>
        {entries?.length ? (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2">
              <Badge variant="secondary" className="shrink-0">
                {KIND_LABEL[entry.kind ?? 'FACT'] ?? entry.kind}
              </Badge>
              <button
                type="button"
                className="line-clamp-2 min-w-0 text-left hover:underline"
                title={entry.scope ?? undefined}
                onClick={() => openPage(entry.pageId)}
              >
                {entry.content}
              </button>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">
            {moduleIds.length === 0
              ? `This ${NOUN[target.type]} has no modules yet, so no fact can be scoped to it.`
              : 'No standing fact is scoped to its code yet.'}
          </p>
        )}
      </div>
    </div>
  );
});
