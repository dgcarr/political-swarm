import { describe, it, expect } from 'vitest';
import { matchesAnyGlob } from './glob.js';

describe('matchesAnyGlob', () => {
  it('matches a leading-** directory pattern anywhere in the path', () => {
    expect(matchesAnyGlob('src/auth/login.js', ['**/auth/**'])).toBe(true);
    expect(matchesAnyGlob('auth/login.js', ['**/auth/**'])).toBe(true);
    expect(matchesAnyGlob('src/other/login.js', ['**/auth/**'])).toBe(false);
  });

  it('matches a **/*substring* pattern against the filename', () => {
    expect(matchesAnyGlob('config/credentials.json', ['**/*credential*'])).toBe(true);
    expect(matchesAnyGlob('src/secrets/keys.js', ['**/*secret*'])).toBe(true);
    expect(matchesAnyGlob('src/index.js', ['**/*secret*'])).toBe(false);
  });

  it('returns false when no glob matches', () => {
    expect(matchesAnyGlob('src/index.js', ['**/auth/**', '**/*secret*'])).toBe(false);
  });

  it('normalizes backslashes before matching', () => {
    expect(matchesAnyGlob('src\\auth\\login.js', ['**/auth/**'])).toBe(true);
  });

  it('deliberately lets a single * cross path separators, same as ** — safer over-matching for security globs', () => {
    // A stricter single-segment `*` would silently fail to match "secret" appearing in a
    // non-final path segment (e.g. a "secrets/" directory) followed by more path — the
    // dangerous failure mode for a security-classification glob. See glob.ts for rationale.
    expect(matchesAnyGlob('src/secrets/keys.js', ['**/*secret*'])).toBe(true);
    expect(matchesAnyGlob('src/a/b/secret.js', ['*secret*'])).toBe(true);
    expect(matchesAnyGlob('secret.js', ['*secret*'])).toBe(true);
  });
  it('treats a trailing slash as the directory and everything under it', () => {
    expect(matchesAnyGlob('tests/test_alloydamage.py', ['tests/'])).toBe(true);
    expect(matchesAnyGlob('tests/unit/test_cli.py', ['tests/'])).toBe(true);
    expect(matchesAnyGlob('mytests/test_cli.py', ['tests/'])).toBe(false);
    expect(matchesAnyGlob('tests.py', ['tests/'])).toBe(false);
  });
});
