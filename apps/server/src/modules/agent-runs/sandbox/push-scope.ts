import { pathBelongsToModule } from 'modules/modules/module-routing';

/**
 * What an agent run may change, checked host-side on the files it actually
 * changed, after the guest is gone.
 *
 * This is the enforcing half of the scope the agent is told about in its
 * prompt and nudged towards by the Vantik Pi extension. Both of those live in
 * the guest, where a prompt-injected agent can ignore or rewrite them; this
 * check runs on the host against the staged diff, so nothing the agent does
 * reaches it.
 */

/**
 * Files a run never pushes, whatever its modules say.
 *
 * CI configuration is the one change that executes before anyone reviews it:
 * a pull request's workflows run when it is opened, with whatever the runner
 * holds — on a self-hosted Forgejo runner that is the host's Docker socket.
 * "The strongest thing an injected agent can do is write a bad patch, which a
 * human reviews" stops being true for exactly these paths.
 */
const PROTECTED: { pattern: RegExp; what: string }[] = [
  { pattern: /^\.github\/workflows\//, what: 'GitHub Actions workflows' },
  { pattern: /^\.github\/actions\//, what: 'GitHub Actions' },
  { pattern: /^\.forgejo\/workflows\//, what: 'Forgejo Actions workflows' },
  { pattern: /^\.gitea\/workflows\//, what: 'Gitea Actions workflows' },
  { pattern: /^\.gitlab-ci\.yml$/, what: 'GitLab CI configuration' },
  { pattern: /^\.gitlab\/ci\//, what: 'GitLab CI configuration' },
  { pattern: /^\.circleci\//, what: 'CircleCI configuration' },
  { pattern: /^\.buildkite\//, what: 'Buildkite pipelines' },
  { pattern: /^\.woodpecker(\.ya?ml|\/)/, what: 'Woodpecker pipelines' },
  { pattern: /^\.drone\.ya?ml$/, what: 'Drone pipelines' },
  { pattern: /^Jenkinsfile$/, what: 'Jenkins pipelines' },
];

export interface ScopeViolation {
  file: string;
  reason: 'protected' | 'outside-modules';
  what?: string;
}

/**
 * The changed files a run may not push. Empty means the push may go ahead.
 *
 * `pathPrefixes` is the union of the issue's modules' prefixes in this
 * repository; empty means a module claims the whole repository, and only the
 * protected paths are refused.
 */
export function scopeViolations(
  files: string[],
  pathPrefixes: string[],
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];

  for (const file of files) {
    const protectedPath = PROTECTED.find(({ pattern }) => pattern.test(file));

    if (protectedPath) {
      violations.push({
        file,
        reason: 'protected',
        what: protectedPath.what,
      });
    } else if (!pathBelongsToModule(file, pathPrefixes)) {
      violations.push({ file, reason: 'outside-modules' });
    }
  }

  return violations;
}

/** A push the host refused because of what it would have changed. */
export class PushScopeError extends Error {
  constructor(
    readonly violations: ScopeViolation[],
    pathPrefixes: string[],
  ) {
    super(describe(violations, pathPrefixes));
    this.name = 'PushScopeError';
  }
}

function describe(violations: ScopeViolation[], pathPrefixes: string[]) {
  const list = (files: ScopeViolation[]) => {
    const shown = files.slice(0, 10).map((v) => v.file);
    return files.length > shown.length
      ? `${shown.join(', ')} and ${files.length - shown.length} more`
      : shown.join(', ');
  };

  const parts: string[] = [];
  const protectedFiles = violations.filter((v) => v.reason === 'protected');
  const outside = violations.filter((v) => v.reason === 'outside-modules');

  if (protectedFiles.length) {
    parts.push(
      `it changed CI configuration (${list(protectedFiles)}), which an agent run never pushes because CI runs it before anyone reviews the change`,
    );
  }

  if (outside.length) {
    parts.push(
      `it changed files outside this issue's modules (${list(outside)}); the modules cover ${pathPrefixes.join(', ')}. If the change belongs there, add that module to the issue and delegate again`,
    );
  }

  return `The host refused to push this run's work: ${parts.join('; and ')}.`;
}
