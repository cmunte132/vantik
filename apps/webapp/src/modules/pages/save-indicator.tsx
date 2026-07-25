import { observer } from 'mobx-react-lite';
import * as React from 'react';

export type SaveState = 'idle' | 'pending' | 'saved' | 'error';

/**
 * Says whether the page has been written down yet.
 *
 * Edits are debounced for a second before they are sent, which means there is a
 * window where the browser holds the only copy of what you typed and nothing on
 * screen admits it. On a documentation page — where people write for minutes at
 * a time and then close the tab — that silence is the difference between trust
 * and a lost paragraph.
 *
 * "Saved" is deliberately shown only after the server confirms. Showing it
 * optimistically would be a lie exactly when it matters, which is when the
 * request failed.
 */
export const SaveIndicator = observer(({ state }: { state: SaveState }) => {
  // Once saved, the label fades out rather than sitting there forever: a
  // permanent "Saved" stops being information after the first second and
  // becomes furniture people no longer read.
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (state === 'idle') {
      setVisible(false);
      return undefined;
    }

    setVisible(true);

    if (state === 'saved') {
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    }

    return undefined;
  }, [state]);

  if (!visible) {
    return null;
  }

  if (state === 'error') {
    return (
      <span className="text-destructive">
        Not saved — check your connection
      </span>
    );
  }

  return (
    <span className="text-muted-foreground">
      {state === 'pending' ? 'Saving…' : 'Saved'}
    </span>
  );
});
