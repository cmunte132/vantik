interface SettingSectionProps {
  title: string;
  description: string;
  metadata?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The two-column frame every settings page sits in: what this page is on the
 * left, the controls on the right.
 *
 * It used to be a single row with a fixed `w-[400px] shrink-0` beside a
 * `max-w-[76ch]` column — about 979px of demand before anything could give,
 * plus a 248px settings nav, so under a ~1227px viewport the content did not
 * narrow, it left the screen. Every one of the twenty-odd pages using this did
 * that, and the ones with a code block or a wide row did it worst.
 *
 * Three things fix it, and the third is the one that is easy to miss:
 * the row stacks below `lg` rather than holding a fixed width; the description
 * only claims a column once there is room for one; and the content column
 * carries `min-w-0`, without which a flex child refuses to shrink below its
 * content and pushes the row wider than its parent no matter what the max
 * width says.
 */
export function SettingSection({
  title,
  description,
  metadata,
  children,
}: SettingSectionProps) {
  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <div className="w-full lg:w-[300px] lg:shrink-0 flex flex-col">
        <h3 className="text-lg"> {title} </h3>
        <p className="text-muted-foreground">{description}</p>
        {metadata ? metadata : null}
      </div>
      <div className="grow min-w-0">
        <div className="flex h-full justify-center w-full min-w-0">
          <div className="grow min-w-0 flex flex-col gap-2 h-full max-w-[68ch]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
