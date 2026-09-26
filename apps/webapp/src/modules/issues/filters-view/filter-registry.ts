import type {
  IssueType,
  LabelType,
  ModuleType,
  WorkflowType,
} from 'common/types';

import {
  FLAG_FILTER_KEYS,
  FilterTypeEnum,
  type FilterModelType,
  type FlagFilterKey,
  type TimeBasedFilterEnum,
  type ValueFilterKey,
} from 'store/application';
import type { StoreContextInstanceType } from 'store/global-context-provider';

/**
 * What each issue filter means.
 *
 * The keys live in `store/application/types.ts`; this says what a stored filter
 * asks of an issue, and `filter-components.tsx` says how it is picked and shown.
 * Both are closed over the keys, so a new key does not compile until it has an
 * entry in each. Nothing here renders, so the specs can import it.
 */

/**
 * One condition on an issue, as `filterIssues` evaluates it: a field compared
 * with values, or a flag filter's key, or one of the display settings' own
 * time conditions.
 */
export interface IssuePredicate {
  key: string;
  filterType: FilterTypeEnum | TimeBasedFilterEnum;
  /** `null` stands for "not set", the choice a picker offers as "No …". */
  value?: Array<string | number | null>;
}

/** What turning a stored filter into predicates may read besides the filter. */
export interface FilterContext {
  workflows: WorkflowType[];
  labels: LabelType[];
  /** Every module of the workspace; a product filter reads as its modules. */
  modules: ModuleType[];
}

export interface ValueFilter {
  name: string;
  /**
   * Whether the issue field holds several values. An array field is asked
   * whether it includes a value; a single field whether it is one.
   */
  isArray: boolean;
  /** The part of the menu this sits in: the issue's own fields, or the product axis. */
  group: 'issue' | 'axis';
  /** Left out of the menu on a project's page, which already is this filter. */
  hiddenInProject?: boolean;
  predicates(filter: FilterModelType, context: FilterContext): IssuePredicate[];
}

export interface FlagFilter {
  name: string;
  /** What the applied chip reads after its operator, as in "is blocked". */
  label: string;
  matches(
    issue: IssueType,
    stores: Pick<
      StoreContextInstanceType,
      'issuesStore' | 'issueRelationsStore'
    >,
  ): boolean;
}

/**
 * A comparison of one issue field with the picked values. `none` is the value
 * a picker uses for its "No …" choice, which asks for the field to be unset; it
 * becomes `null`, so it sits in the same list as the others. As a separate
 * condition it had to hold alongside them, and "no assignee or Ada" matched
 * nothing at all.
 */
function field(key: string, none?: string) {
  return (filter: FilterModelType): IssuePredicate[] => [
    {
      key,
      filterType: filter.filterType,
      value: none
        ? filter.value.map((value) => (value === none ? null : value))
        : filter.value,
    },
  ];
}

/** Status and label filters store names, which span teams; issues hold ids. */
function namesToIds(
  names: string[],
  known: Array<{ name: string; ids?: string[] }>,
) {
  return names.flatMap(
    (name) => known.find((candidate) => candidate.name === name)?.ids ?? [],
  );
}

export const VALUE_FILTERS: Record<ValueFilterKey, ValueFilter> = {
  status: {
    name: 'Status',
    isArray: false,
    group: 'issue',
    predicates: (filter, { workflows }) => [
      {
        key: 'stateId',
        filterType: filter.filterType,
        value: namesToIds(filter.value, workflows),
      },
    ],
  },
  assignee: {
    name: 'Assignee',
    isArray: false,
    group: 'issue',
    predicates: field('assigneeId', 'no-user'),
  },
  label: {
    name: 'Label',
    isArray: true,
    group: 'issue',
    predicates: (filter, { labels }) => [
      {
        key: 'labelIds',
        filterType: filter.filterType,
        value: namesToIds(filter.value, labels),
      },
    ],
  },
  priority: {
    name: 'Priority',
    isArray: false,
    group: 'issue',
    predicates: field('priority'),
  },
  cycle: {
    name: 'Cycle',
    isArray: false,
    group: 'issue',
    predicates: field('cycleId', 'no-cycle'),
  },
  project: {
    name: 'Project',
    isArray: false,
    group: 'issue',
    hiddenInProject: true,
    predicates: field('projectId', 'no-project'),
  },
  // A product owns modules and borrows others, and its issues are the issues of
  // all of them; an issue never names a product. A product with no module gives
  // an empty list, and then the page shows nothing, which is the truth.
  product: {
    name: 'Product',
    isArray: false,
    group: 'axis',
    predicates: (filter, { modules }) => [
      {
        key: 'moduleIds',
        filterType:
          filter.filterType === FilterTypeEnum.IS_NOT
            ? FilterTypeEnum.EXCLUDES
            : FilterTypeEnum.INCLUDES,
        value: modules
          .filter(
            (candidate) =>
              filter.value.includes(candidate.ownerProductId) ||
              (candidate.linkedProductIds ?? []).some((linked: string) =>
                filter.value.includes(linked),
              ),
          )
          .map((candidate) => candidate.id),
      },
    ],
  },
  // An issue can change more than one module, so this is an array, like labels.
  module: {
    name: 'Module',
    isArray: true,
    group: 'axis',
    predicates: field('moduleIds'),
  },
  capability: {
    name: 'Capability',
    isArray: false,
    group: 'axis',
    predicates: field('capabilityId'),
  },
};

export const FLAG_FILTERS: Record<FlagFilterKey, FlagFilter> = {
  isParent: {
    name: 'Parent issues',
    label: 'parent',
    // `isSubIssue` on the store answers whether the issue has sub-issues.
    matches: (issue, { issuesStore }) => issuesStore.isSubIssue(issue.id),
  },
  isSubIssue: {
    name: 'Sub issues',
    label: 'sub-issue',
    matches: (issue) => !!issue.parentId,
  },
  isBlocked: {
    name: 'Blocked issues',
    label: 'blocked',
    matches: (issue, { issueRelationsStore }) =>
      issueRelationsStore.isBlocked(issue.id),
  },
  isBlocking: {
    name: 'Blocking issues',
    label: 'blocking',
    matches: (issue, { issueRelationsStore }) =>
      issueRelationsStore.isBlocking(issue.id),
  },
};

export function isFlagFilter(key: string): key is FlagFilterKey {
  return (FLAG_FILTER_KEYS as readonly string[]).includes(key);
}

/** The operators a value filter offers: the first is what a new filter uses. */
export function operatorsFor(key: ValueFilterKey | FlagFilterKey) {
  return !isFlagFilter(key) && VALUE_FILTERS[key].isArray
    ? [FilterTypeEnum.INCLUDES, FilterTypeEnum.EXCLUDES]
    : [FilterTypeEnum.IS, FilterTypeEnum.IS_NOT];
}

export function defaultOperator(key: ValueFilterKey | FlagFilterKey) {
  return operatorsFor(key)[0];
}

/**
 * The operator a filter can actually hold for a requested one, for callers
 * that did not choose from the filter's own menu (the AI filter). An "is" on
 * an array field means "includes", and a "not" stays a "not".
 */
export function operatorFor(
  key: ValueFilterKey | FlagFilterKey,
  requested: FilterTypeEnum,
) {
  const [positive, negative] = operatorsFor(key);
  const negated =
    requested === FilterTypeEnum.IS_NOT ||
    requested === FilterTypeEnum.EXCLUDES;

  return negated ? negative : positive;
}
