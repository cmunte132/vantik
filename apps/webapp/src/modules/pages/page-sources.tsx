import * as React from 'react';

import { usePageSources } from 'services/pages';

const TRUST_LABEL: Record<string, string> = {
  HUMAN_VERIFIED: 'verified',
  GROUNDED: 'grounded',
  OBSERVED: 'observed',
  UNGROUNDED: 'ungrounded',
};

/**
 * What a generated page was written from, section by section.
 *
 * The body above is a model's prose; this is what it rests on, each fact
 * with its trust tier, so a reader can check one against the other. A fact
 * no longer in use is said to be, since the next refresh rewrites what
 * rests on it.
 */
export function PageSources({
  pageId,
  revision,
}: {
  pageId: string;
  revision?: string;
}) {
  const { data: sections } = usePageSources(pageId, revision);

  if (!sections || sections.length === 0) {
    return null;
  }

  return (
    <section className="border-t border-border mt-8 pt-4 flex flex-col gap-3">
      <h2 className="text-muted-foreground">Written from</h2>

      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1">
          <p>{section.heading}</p>
          <ul className="flex flex-col gap-1 pl-3">
            {section.sources.map(({ id, entry }) => (
              <li key={id} className="text-muted-foreground">
                {entry ? (
                  <>
                    <span className="text-foreground">{entry.content}</span>
                    {entry.trust && TRUST_LABEL[entry.trust]
                      ? ` · ${TRUST_LABEL[entry.trust]}`
                      : ''}
                  </>
                ) : (
                  'A fact no longer in use: the next refresh rewrites this section.'
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
