import type { PageLink } from 'services/pages';

/** Where a link leads, as a route the router can push. */
export interface LinkRoute {
  pathname: string;
  query: Record<string, string>;
}

/**
 * The route for what a page is linked to, or null when there is none.
 *
 * Pages, projects and capabilities are addressed by id; issues, teams,
 * products and modules are not. The issue route parses its parameter as
 * "ENG-42" and the product and module routes look up a key, so a uuid
 * resolves nothing and the reader lands on a blank page rather than the thing
 * they clicked.
 */
export function linkRoute(
  link: Pick<PageLink, 'entityType' | 'entityId' | 'key'>,
  workspaceSlug: string,
): LinkRoute | null {
  switch (link.entityType) {
    case 'PAGE':
      return {
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { workspaceSlug, pageId: link.entityId },
      };
    case 'PROJECT':
      return {
        pathname: '/[workspaceSlug]/projects/[projectId]',
        query: { workspaceSlug, projectId: link.entityId },
      };
    case 'CAPABILITY':
      return {
        pathname: '/[workspaceSlug]/capability/[capabilityId]',
        query: { workspaceSlug, capabilityId: link.entityId },
      };
    case 'ISSUE':
      return link.key
        ? {
            pathname: '/[workspaceSlug]/issue/[issueId]',
            query: { workspaceSlug, issueId: link.key },
          }
        : null;
    case 'TEAM':
      return link.key
        ? {
            pathname: '/[workspaceSlug]/team/[teamIdentifier]/all',
            query: { workspaceSlug, teamIdentifier: link.key },
          }
        : null;
    case 'PRODUCT':
      return link.key
        ? {
            pathname: '/[workspaceSlug]/product/[productKey]',
            query: { workspaceSlug, productKey: link.key },
          }
        : null;
    case 'MODULE':
      return link.key
        ? {
            pathname: '/[workspaceSlug]/module/[moduleKey]',
            query: { workspaceSlug, moduleKey: link.key },
          }
        : null;
    default:
      return null;
  }
}
