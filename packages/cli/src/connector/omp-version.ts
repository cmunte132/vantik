/**
 * The omp versions that `vantik connect` is tested with.
 *
 * omp has no stable API. The connector reads its event stream, its RPC
 * commands and the tools of the Vantik extension. A new omp version can
 * change any of them without notice, so the connector pins a range.
 *
 * To bump the range:
 * 1. Install the new omp version.
 * 2. Run `pnpm --filter @vantikhq/cli test:omp-contract`. It starts omp
 *    against a mock model server and checks the event stream and the
 *    extension.
 * 3. If the test fails, fix the connector or the extension first.
 * 4. Change `OMP_MIN_VERSION` and `OMP_MAX_VERSION_EXCLUSIVE` here.
 *
 * A version outside the range still connects. The connector logs a warning,
 * and the delegate control shows the same warning to the person.
 */

/** The oldest omp version that passes the contract test. */
export const OMP_MIN_VERSION = '18.8.6';

/** The first omp version that is not tested. */
export const OMP_MAX_VERSION_EXCLUSIVE = '18.9.0';

/** The range, as text for messages. */
export const SUPPORTED_OMP_VERSIONS = `>=${OMP_MIN_VERSION} <${OMP_MAX_VERSION_EXCLUSIVE}`;

type Triple = [number, number, number];

function parts(version: string): Triple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  return 0;
}

/** Whether the connector is tested with this omp version. */
export function isSupportedOmpVersion(version: string | null): boolean {
  const found = version ? parts(version) : null;
  const min = parts(OMP_MIN_VERSION);
  const max = parts(OMP_MAX_VERSION_EXCLUSIVE);
  return (
    found !== null &&
    min !== null &&
    max !== null &&
    compare(found, min) >= 0 &&
    compare(found, max) < 0
  );
}
