import { Input } from '@vantikhq/ui/components/input';
import { Switch } from '@vantikhq/ui/components/switch';
import * as React from 'react';

/**
 * Whether a second agent reads the work, and what the whole attempt may spend.
 *
 * Two settings on one screen because they are one decision. Reviewing costs
 * money — a pass is another model call over the whole diff, and a rejected pass
 * buys another implement pass after it — so a ceiling that nobody can see is a
 * bill nobody expected. The number of passes and the money are the two ways to
 * say the same thing, and both are here.
 *
 * The switch defaults on. The alternative is a pull request that nothing has
 * read, which is the failure hosted execution exists to avoid; a workspace that
 * would rather have the cheaper thing can say so, but it should be a decision
 * rather than a default nobody noticed.
 */
export function ReviewCycle({
  phases,
  limits,
  onChange,
}: {
  phases: { review?: boolean };
  limits: { maxCycles?: number; maxCostUsd?: number };
  onChange: (next: {
    phases: { review?: boolean };
    limits: { maxCycles?: number; maxCostUsd?: number };
  }) => void;
}) {
  const reviewing = phases.review ?? true;

  const set = (
    next: Partial<{
      review: boolean;
      maxCycles?: number;
      maxCostUsd?: number;
    }>,
  ) =>
    onChange({
      phases: {
        ...phases,
        ...('review' in next ? { review: next.review } : {}),
      },
      limits: {
        ...limits,
        ...('maxCycles' in next ? { maxCycles: next.maxCycles } : {}),
        ...('maxCostUsd' in next ? { maxCostUsd: next.maxCostUsd } : {}),
      },
    });

  return (
    <div className="flex flex-col gap-4 max-w-[500px]">
      <label className="flex items-start gap-3">
        <Switch
          checked={reviewing}
          onCheckedChange={(checked) => set({ review: checked })}
        />

        <span className="flex flex-col gap-0.5">
          <span>Review every change before handing it back</span>
          <span className="text-muted-foreground">
            A second agent, which did not write the code, reads the diff against
            the issue and reports what is missing. What it finds goes back to be
            fixed, and it reads the result again. Turning this off delivers the
            first attempt as it stands.
          </span>
        </span>
      </label>

      {reviewing && (
        <div className="flex flex-col gap-3 pl-11">
          <Budget
            label="Review passes"
            value={limits.maxCycles}
            placeholder="3"
            hint="How many times the work may go round before a person is asked to look. Three is the default; past that a loop is usually rewording rather than fixing."
            onChange={(value) => set({ maxCycles: value })}
          />

          <Budget
            label="Spend per issue (USD)"
            value={limits.maxCostUsd}
            placeholder="5"
            step="0.5"
            hint="Everything one attempt may cost, across every pass. The cap that matters, because it is the one denominated in what is being spent."
            onChange={(value) => set({ maxCostUsd: value })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A ceiling, or nothing.
 *
 * Cleared back to `undefined` rather than to zero when the box is emptied: a
 * zero ceiling is a run that can never take a pass, which surfaces as every
 * delegation failing instantly for a reason nobody would look for in a settings
 * field. Empty means "use the default", and the placeholder says what that is.
 */
function Budget({
  label,
  value,
  placeholder,
  hint,
  step,
  onChange,
}: {
  label: string;
  value?: number;
  placeholder: string;
  hint: string;
  step?: string;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = React.useState(String(value ?? ''));

  // Kept in step when the stored value changes underneath — a save that failed,
  // or another admin editing the same workspace.
  React.useEffect(() => {
    setDraft(String(value ?? ''));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);

    if (!draft.trim() || !Number.isFinite(parsed) || parsed <= 0) {
      setDraft('');
      onChange(undefined);
      return;
    }

    onChange(parsed);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="w-44 shrink-0">{label}</span>

        <Input
          className="w-28"
          type="number"
          min="0"
          step={step ?? '1'}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      </div>

      <span className="pl-47 text-muted-foreground">{hint}</span>
    </div>
  );
}
