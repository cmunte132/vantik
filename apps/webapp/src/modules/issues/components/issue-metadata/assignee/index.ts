import React from 'react';

export * from './issue-assignee-dropdown-content';
export * from './issue-assignee-dropdown';
export * from './issue-assignee-dropdown-without-context';

const IssueAssigneeDropdown = React.lazy(() =>
  import('./issue-assignee-dropdown').then((mod) => ({
    default: mod.IssueAssigneeDropdown,
  })),
);

/**
 * Loads the dropdown on first render. Its own Suspense boundary renders
 * nothing while the chunk loads, so the wait stays inside this cell instead of
 * suspending the page around it.
 */
export function LazyIssueAssigneeDropdown(
  props: React.ComponentProps<typeof IssueAssigneeDropdown>,
) {
  return React.createElement(
    React.Suspense,
    { fallback: null },
    React.createElement(IssueAssigneeDropdown, props),
  );
}
