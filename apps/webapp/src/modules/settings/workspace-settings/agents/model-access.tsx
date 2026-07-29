import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import * as React from 'react';

import {
  type CredentialHandle,
  type ProviderOption,
  useModelProviders,
  usePutCredentialMutation,
  useRemoveCredentialMutation,
} from 'services/workspace-credentials';

/**
 * Which model providers this workspace can run agents on.
 *
 * The screen is built around one idea: a person pasting a key should find out
 * straight away whether it works and what it buys them. So saving a key asks
 * the provider to list what the key can reach, and the answer becomes the
 * model menu below it. A key the provider refuses is not stored at all — the
 * error shown is the provider's own verdict, not a guess.
 *
 * That also means nobody has to know model ids, which is the difference
 * between this and a text box. Bringing a second provider is adding a row,
 * and choosing between them is a menu rather than a memory exercise.
 */
export function ModelAccess({
  credentials,
  defaults,
  onDefaultsChange,
}: {
  credentials: CredentialHandle[];
  /** The provider, model and thinking level runs use unless told otherwise. */
  defaults: { provider?: string; model?: string; thinking?: string };
  onDefaultsChange: (next: {
    provider?: string;
    model?: string;
    thinking?: string;
  }) => void;
}) {
  const { data: providers = [] } = useModelProviders();
  const [adding, setAdding] = React.useState(false);

  const keys = credentials.filter(
    (entry) => entry.kind === 'MODEL_API_KEY' && entry.provider,
  );
  const configured = new Set(keys.map((entry) => entry.provider));
  const available = providers.filter((entry) => !configured.has(entry.id));

  return (
    <div className="flex flex-col gap-3 max-w-[500px]">
      {keys.length === 0 && !adding && (
        <p className="text-muted-foreground">
          No provider is configured, so no agent can run. Add a key from
          whichever model provider you already pay for.
        </p>
      )}

      {keys.map((handle) => (
        <ProviderRow
          key={handle.provider}
          handle={handle}
          provider={providers.find((entry) => entry.id === handle.provider)}
        />
      ))}

      {adding ? (
        <AddProvider
          providers={available}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        available.length > 0 && (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAdding(true)}
            >
              {keys.length ? 'Add another provider' : 'Add a provider'}
            </Button>
          </div>
        )
      )}

      {keys.length > 0 && (
        <RunDefaults
          keys={keys}
          providers={providers}
          defaults={defaults}
          onChange={onDefaultsChange}
        />
      )}
    </div>
  );
}

/** One configured provider: which key, what it reaches, and how to change it. */
function ProviderRow({
  handle,
  provider,
}: {
  handle: CredentialHandle;
  provider?: ProviderOption;
}) {
  const { mutate: remove } = useRemoveCredentialMutation();
  const models = handle.models ?? [];

  return (
    <div className="flex items-start justify-between gap-2 bg-background-3 rounded-lg p-2 px-3">
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span>{provider?.label ?? handle.provider}</span>
          <span className="font-mono text-muted-foreground">{handle.hint}</span>
          {/* An empty list and an unchecked key are different situations, and
              a row that showed nothing for both would hide the one that needs
              attention. */}
          {models.length > 0 ? (
            <Badge variant="secondary">{models.length} models</Badge>
          ) : (
            <Badge variant="outline">not checked</Badge>
          )}
        </div>
        {handle.baseUrl && (
          <span className="text-muted-foreground truncate">
            {handle.baseUrl}
          </span>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          remove({ kind: 'MODEL_API_KEY', provider: handle.provider })
        }
      >
        Remove
      </Button>
    </div>
  );
}

/** Pick a provider, paste a key, and find out whether it works. */
function AddProvider({
  providers,
  onDone,
  onCancel,
}: {
  providers: ProviderOption[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [providerId, setProviderId] = React.useState(providers[0]?.id ?? '');
  const [secret, setSecret] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const provider = providers.find((entry) => entry.id === providerId);

  const { mutate: put, isPending } = usePutCredentialMutation({
    onSuccess: (result) => {
      // Stored, but the provider could not be asked. Said out loud rather than
      // left to look like a key that reaches nothing.
      if (result.note) {
        setNote(result.note);
        return;
      }
      onDone();
    },
    onError: setError,
  });

  const save = () => {
    setError(null);
    setNote(null);

    if (!secret.trim()) {
      setError('Paste the key before saving.');
      return;
    }

    put({
      kind: 'MODEL_API_KEY',
      provider: providerId,
      secret: secret.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    });
  };

  if (note) {
    return (
      <div className="flex flex-col gap-2 bg-background-3 rounded-lg p-3">
        <span>The key is stored.</span>
        <span className="text-muted-foreground">{note}</span>
        <div>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 bg-background-3 rounded-lg p-3">
      <div className="flex flex-col gap-1">
        <label className="text-muted-foreground">Provider</label>
        <Select value={providerId} onValueChange={setProviderId}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providers.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-muted-foreground">API key</label>
        <Input
          autoFocus
          type="password"
          value={secret}
          placeholder={provider?.placeholder ?? '…'}
          onChange={(event) => setSecret(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && save()}
        />
        <span className="text-muted-foreground">
          {provider?.discoversModels
            ? `Checked against ${provider.label} when you save, and the models it opens appear here.`
            : 'Stored encrypted. It is never shown again after this.'}
        </span>
      </div>

      {provider?.baseUrl && (
        <div className="flex flex-col gap-1">
          <label className="text-muted-foreground">
            Endpoint{provider.baseUrl.required ? '' : ' — optional'}
          </label>
          <Input
            value={baseUrl}
            placeholder={provider.baseUrl.placeholder}
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" isLoading={isPending} onClick={save}>
          {provider?.discoversModels ? 'Check and save' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

/**
 * What a run uses when the person delegating does not say.
 *
 * Only shown once there is a key, because every field here is a choice among
 * what that key opens. The model menu is the provider's own list, so nobody
 * has to know that `claude-opus-4-5` is spelled with hyphens.
 */
function RunDefaults({
  keys,
  providers,
  defaults,
  onChange,
}: {
  keys: CredentialHandle[];
  providers: ProviderOption[];
  defaults: { provider?: string; model?: string; thinking?: string };
  onChange: (next: {
    provider?: string;
    model?: string;
    thinking?: string;
  }) => void;
}) {
  // One provider means there is nothing to choose, so the choice is not
  // offered — it is simply what runs use.
  const chosen =
    keys.find((entry) => entry.provider === defaults.provider) ??
    (keys.length === 1 ? keys[0] : undefined);

  const models = chosen?.models ?? [];

  return (
    <div className="flex flex-col gap-3 pt-1">
      {keys.length > 1 && (
        <Field label="Runs use">
          <Select
            value={chosen?.provider ?? ''}
            onValueChange={(provider) =>
              // The model belongs to the old provider, so it goes with it.
              // Keeping it would name a model the new key cannot reach.
              onChange({ ...defaults, provider, model: undefined })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {keys.map((entry) => (
                  <SelectItem key={entry.provider} value={entry.provider}>
                    {providers.find((item) => item.id === entry.provider)
                      ?.label ?? entry.provider}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Model">
        {models.length > 0 ? (
          <Select
            value={defaults.model ?? ''}
            onValueChange={(model) =>
              onChange({ ...defaults, provider: chosen?.provider, model })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="The provider's default" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          // No list to offer, because the provider publishes none or could not
          // be reached. A text box is worse than a menu but better than being
          // unable to name a model at all.
          <Input
            className="font-mono"
            value={defaults.model ?? ''}
            placeholder="Model id — the provider's default if empty"
            onChange={(event) =>
              onChange({
                ...defaults,
                provider: chosen?.provider,
                model: event.currentTarget.value,
              })
            }
          />
        )}
      </Field>

      <Field label="Reasoning">
        <Select
          value={defaults.thinking ?? 'medium'}
          onValueChange={(thinking) => onChange({ ...defaults, thinking })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {THINKING.map((level) => (
                <SelectItem key={level.id} value={level.id}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">
          {THINKING.find(
            (level) => level.id === (defaults.thinking ?? 'medium'),
          )?.description ?? ''}
        </span>
      </Field>
    </div>
  );
}

/**
 * Pi's thinking levels, said in terms of the trade they make.
 *
 * The names are Pi's and are passed through unchanged. What is added is what
 * each one costs, because that is the question somebody setting this is
 * actually asking.
 */
const THINKING = [
  {
    id: 'off',
    label: 'Off',
    description: 'Fastest and cheapest. Fine for a rename or a one-line fix.',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Barely deliberates. Small, well-specified changes.',
  },
  { id: 'low', label: 'Low', description: 'Some deliberation, still cheap.' },
  {
    id: 'medium',
    label: 'Medium',
    description: 'The usual trade between cost and getting it right.',
  },
  {
    id: 'high',
    label: 'High',
    description: 'Thinks harder. Worth it for work that spans several files.',
  },
  {
    id: 'xhigh',
    label: 'Very high',
    description: 'Slow and expensive. For genuinely hard problems.',
  },
  {
    id: 'max',
    label: 'Maximum',
    description: 'Everything the model has. Expect the bill to show it.',
  },
];

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
