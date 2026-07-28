import { Badge } from '@vantikhq/ui/components/badge';
import { observer } from 'mobx-react-lite';
import { useParams } from 'next/navigation';

import { useContextStore } from 'store/global-context-provider';

export const Metadata = observer(() => {
  const { actionSlug } = useParams<{ actionSlug: string }>();
  const { actionsStore } = useContextStore();
  const action = actionsStore.getAction(actionSlug);

  return (
    <div className="grow flex flex-col gap-4">
      <div className="min-w-[80px] flex flex-col gap-1">
        <div className="flex gap-1">
          {action?.integrations.map((integration: string) => (
            <Badge
              variant="secondary"
              key={integration}
              className="flex items-center gap-1 text-base"
            >
              {integration}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
});
