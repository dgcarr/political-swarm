import { describe, it, expect } from 'vitest';
import { classifyRiskByPaths } from './risk.js';

const securityPathGlobs = ['**/auth/**', '**/security/**', '**/*secret*', '**/*credential*'];

describe('classifyRiskByPaths', () => {
  it('classifies no touched paths as low risk', () => {
    expect(classifyRiskByPaths([], { securityPathGlobs })).toBe('low');
  });

  it('classifies a single-module change as low risk', () => {
    expect(classifyRiskByPaths(['src/utils/math.js'], { securityPathGlobs })).toBe('low');
  });

  it('classifies changes spanning multiple top-level modules as medium risk', () => {
    expect(classifyRiskByPaths(['src/foo.js', 'tests/foo.test.js'], { securityPathGlobs })).toBe('medium');
  });

  it('classifies anything touching a security-path glob as high risk regardless of module count', () => {
    expect(classifyRiskByPaths(['src/auth/login.js'], { securityPathGlobs })).toBe('high');
    expect(classifyRiskByPaths(['config/credentials.json'], { securityPathGlobs })).toBe('high');
  });

  it('respects a custom crossModuleThreshold', () => {
    const paths = ['a/x.js', 'b/y.js', 'c/z.js'];
    expect(classifyRiskByPaths(paths, { securityPathGlobs, crossModuleThreshold: 2 })).toBe('medium');
    expect(classifyRiskByPaths(paths, { securityPathGlobs, crossModuleThreshold: 10 })).toBe('low');
  });

  it('handles Windows-style backslash paths the same as forward-slash paths', () => {
    expect(classifyRiskByPaths(['src\\auth\\login.js'], { securityPathGlobs })).toBe('high');
  });
});
