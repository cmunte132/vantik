import { isSupportedOmpVersion } from './omp-version';

describe('isSupportedOmpVersion', () => {
  it('accepts versions in the range', () => {
    expect(isSupportedOmpVersion('18.8.6')).toBe(true);
    expect(isSupportedOmpVersion('18.8.12')).toBe(true);
  });

  it('refuses versions outside the range, and unknown ones', () => {
    expect(isSupportedOmpVersion('18.8.5')).toBe(false);
    expect(isSupportedOmpVersion('18.9.0')).toBe(false);
    expect(isSupportedOmpVersion('19.0.0')).toBe(false);
    expect(isSupportedOmpVersion(null)).toBe(false);
    expect(isSupportedOmpVersion('nonsense')).toBe(false);
  });
});
