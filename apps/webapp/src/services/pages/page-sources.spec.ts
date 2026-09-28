import { describe, expect, it } from 'vitest';

import {
  citedEntriesUrl,
  readSectionRefs,
  sectionSources,
} from './page-sources';

const query = (url: string) => new URL(url, 'http://vantik.test').searchParams;

describe('what a generated page is written from', () => {
  it('[KG-7.1] asks for the entries its sections cite, once each, in use only', () => {
    const url = citedEntriesUrl(['e-2', 'e-1', 'e-2']) as string;

    expect(url.startsWith('/api/v1/page_entries?')).toBe(true);
    expect(query(url).get('ids')).toBe('e-1,e-2');
    expect(query(url).get('status')).toBe('STANDING,CONSOLIDATED');
    // A page that cites nothing asks for nothing.
    expect(citedEntriesUrl([])).toBeNull();
  });

  it('[KG-7.1] shows each section with what it cites, and which of it is out of use', () => {
    const sections = readSectionRefs([
      {
        id: 'sec_deploy',
        heading: 'Deploying',
        body: 'Merge to main.',
        entryIds: ['e-deploy', 'e-gone'],
        evidence: 'abc',
      },
      { id: 'sec_broken', heading: 3, entryIds: [] },
      'not a section',
    ]);

    expect(sections).toEqual([
      {
        id: 'sec_deploy',
        heading: 'Deploying',
        entryIds: ['e-deploy', 'e-gone'],
      },
    ]);
    expect(readSectionRefs(null)).toEqual([]);

    const deploy = {
      id: 'e-deploy',
      content: 'Deploys go out from main on merge.',
      status: 'STANDING',
      trust: 'GROUNDED',
    };
    expect(sectionSources(sections, [deploy])).toEqual([
      {
        id: 'sec_deploy',
        heading: 'Deploying',
        sources: [
          { id: 'e-deploy', entry: deploy },
          { id: 'e-gone', entry: null },
        ],
      },
    ]);
  });
});
