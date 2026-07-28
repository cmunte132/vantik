import type { ParsedUrlQuery } from 'querystring';

import { FilterTypeEnum } from 'store/application';

/** The query parameters that this reads, and the filter each one sets. */
const AXIS_PARAMS = ['product', 'module', 'capability'] as const;

interface QueryFilters {
  filters: Record<string, { value: string[]; filterType: FilterTypeEnum }>;
  rest: ParsedUrlQuery;
}

/**
 * This function reads a link such as `/all?module=<id>` as a set of filters.
 *
 * A page that counts the issues of a module hands the reader to the list, and
 * the list must show that module and no other. A visible filter says which one,
 * and the reader can change it or remove it. A silent filter cannot do this,
 * because a list that is narrower than it looks is worse than no link at all.
 *
 * The caller applies these filters after `applicationStore.load`, and never
 * before. That method reads the filters of the page from local storage and
 * replaces everything, so a filter written before it is lost.
 *
 * The caller then takes the parameter out of the address. The filter bar owns
 * the state from that moment, and a reload does not put back a filter that the
 * reader took off.
 */
export function readFiltersFromQuery(query: ParsedUrlQuery): QueryFilters {
  const filters: QueryFilters['filters'] = {};
  const rest = { ...query };

  for (const param of AXIS_PARAMS) {
    const raw = query[param];

    if (!raw) {
      continue;
    }

    const value = (Array.isArray(raw) ? raw : raw.split(',')).filter(Boolean);

    if (value.length === 0) {
      continue;
    }

    filters[param] = {
      value,
      // An issue holds a list of modules and one capability. A product reads as
      // the modules of that product, which is also a comparison of one value
      // here.
      filterType:
        param === 'module' ? FilterTypeEnum.INCLUDES : FilterTypeEnum.IS,
    };

    delete rest[param];
  }

  return { filters, rest };
}
