import * as React from 'react';

/**
 * A titled block on a product or module page.
 *
 * These pages are read before they are edited, so the explanation sits under the
 * heading rather than in a tooltip. Somebody who has never met a module should
 * be able to work out what one is from this page alone.
 */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <h2 className="font-medium">{title}</h2>
          {description && (
            <p className="text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>

      <div className="rounded-md border border-border">{children}</div>
    </section>
  );
}
