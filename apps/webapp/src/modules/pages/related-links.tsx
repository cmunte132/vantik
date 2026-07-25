import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { AddLine, CrossLine } from '@vantikhq/ui/icons';
import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import { useContextStore } from 'store/global-context-provider';

import {
  type PageLink,
  type PageLinkType,
  useCreatePageLinkMutation,
  useDeletePageLinkMutation,
  usePageLinks,
} from 'services/pages';

/**
 * What this page is about, in the workspace's own terms.
 *
 * Nesting puts a page in one place in one tree. Plenty of documentation does
 * not belong in one place: a deployment runbook is about a project *and* the
 * team that owns it, and lives under neither. These are those edges, and
 * because they are indexed in both directions they are also what an agent
 * follows — handed an issue, it can be given the pages for that issue's project
 * without knowing what any of them are called.
 *
 * Kept at the foot of the page with "Referenced by" rather than in the rail:
 * this is navigation between documents and work, which is a human's business.
 * The rail is what the page tells agents.
 */
export const RelatedLinks = observer(({ pageId }: { pageId: string }) => {
  const { data: links } = usePageLinks(pageId);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { workspaceSlug } = router.query;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['page-links', pageId] });

  const { mutate: remove } = useDeletePageLinkMutation({ onSuccess: refresh });

  // Pages and projects are addressed by id; issues and teams are not. The issue
  // route parses its parameter as "ENG-42" — identifier before the dash, number
  // after — so a uuid resolves to no team and a NaN number, and the reader
  // lands on a blank page rather than the issue they clicked.
  const open = (link: PageLink) => {
    if (link.entityType === 'PAGE') {
      router.push({
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { workspaceSlug, pageId: link.entityId },
      });
    } else if (link.entityType === 'PROJECT') {
      router.push({
        pathname: '/[workspaceSlug]/projects/[projectId]',
        query: { workspaceSlug, projectId: link.entityId },
      });
    } else if (link.entityType === 'ISSUE' && link.key) {
      router.push({
        pathname: '/[workspaceSlug]/issue/[issueId]',
        query: { workspaceSlug, issueId: link.key },
      });
    } else if (link.entityType === 'TEAM' && link.key) {
      router.push({
        pathname: '/[workspaceSlug]/team/[teamIdentifier]/all',
        query: { workspaceSlug, teamIdentifier: link.key },
      });
    }
  };

  return (
    <section className="border-t border-border mt-8 pt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-muted-foreground grow">Related</h2>
        <AddLink pageId={pageId} onAdded={refresh} />
      </div>

      {(!links || links.length === 0) && (
        <p className="text-muted-foreground">
          Nothing yet. Linking this page to the team, project or issue it is
          about is how the next person — or the next agent — finds it from the
          work rather than by searching for it.
        </p>
      )}

      <div className="flex flex-col gap-px">
        {links?.map((link) => (
          <div
            key={link.id}
            className="group flex items-center gap-2 rounded px-2 py-1 -mx-2 hover:bg-grayAlpha-100"
          >
            <span className="text-muted-foreground w-[64px] shrink-0">
              {KIND_LABEL[link.entityType]}
            </span>

            <button
              type="button"
              className="grow min-w-0 text-left truncate hover:underline"
              onClick={() => open(link)}
            >
              {link.label}
            </button>

            <Button
              variant="ghost"
              size="sm"
              aria-label={`Unlink ${link.label}`}
              className="shrink-0 h-6 px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => remove({ pageId, linkId: link.id })}
            >
              <CrossLine size={12} />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
});

const KIND_LABEL: Record<PageLinkType, string> = {
  TEAM: 'Team',
  PROJECT: 'Project',
  ISSUE: 'Issue',
  PAGE: 'Page',
};

/**
 * Adding a link.
 *
 * Teams, projects and pages come from the synced stores, so the list is
 * immediate and searchable without a round trip. Issues are deliberately absent
 * here: a workspace has thousands, and an unbounded picker is a worse way to
 * link an issue than the issue's own page will be — while an agent, which is
 * what mostly links issues, already has the id in hand.
 */
const AddLink = observer(
  ({ pageId, onAdded }: { pageId: string; onAdded: () => void }) => {
    const [open, setOpen] = React.useState(false);
    const { teamsStore, projectsStore, pagesStore } = useContextStore();

    const { mutate: create } = useCreatePageLinkMutation({
      onSuccess: () => {
        setOpen(false);
        onAdded();
      },
    });

    const add = (entityType: PageLinkType, entityId: string) =>
      create({ pageId, entityType, entityId });

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1 px-1">
            <AddLine size={14} />
            Link
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[320px] p-0">
          <Command>
            <CommandInput placeholder="Find a team, project or page…" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>

              <CommandGroup heading="Teams">
                {teamsStore.getTeams.map((team: { id: string; name: string }) => (
                  <CommandItem
                    key={team.id}
                    value={`team ${team.name}`}
                    onSelect={() => add('TEAM', team.id)}
                  >
                    {team.name}
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandGroup heading="Projects">
                {projectsStore.getProjects.map(
                  (project: { id: string; name: string }) => (
                    <CommandItem
                      key={project.id}
                      value={`project ${project.name}`}
                      onSelect={() => add('PROJECT', project.id)}
                    >
                      {project.name}
                    </CommandItem>
                  ),
                )}
              </CommandGroup>

              <CommandGroup heading="Pages">
                {pagesStore.getPages
                  .filter((page: { id: string }) => page.id !== pageId)
                  .map((page: { id: string; title: string }) => (
                    <CommandItem
                      key={page.id}
                      value={`page ${page.title}`}
                      onSelect={() => add('PAGE', page.id)}
                    >
                      {page.title || 'Untitled page'}
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);
