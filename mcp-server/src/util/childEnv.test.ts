import { describe, expect, it } from 'vitest';
import { checkEnv, gitEnv } from './childEnv.js';

const source = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'C',
  VIRTUAL_ENV: '/venv',
  OPENROUTER_API_KEY: 'sk-or-secret',
  GITHUB_TOKEN: 'ghp_secret',
  AWS_SECRET_ACCESS_KEY: 'aws',
  DB_PASSWORD: 'pw',
  GIT_DIR: '/elsewhere/.git',
  GIT_AUTHOR_NAME: 'Dev',
  NODE_OPTIONS: '--require /tmp/x.js',
};

describe('checkEnv', () => {
  it('keeps only the allow-list, adds CI, and drops every credential-looking name', () => {
    expect(checkEnv(source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_GB.UTF-8',
      LC_ALL: 'C',
      VIRTUAL_ENV: '/venv',
      CI: '1',
    });
  });

  it('drops a credential-looking name even under an allowed prefix', () => {
    expect(checkEnv({ LC_API_KEY: 'x' })).toEqual({ CI: '1' });
  });
});

describe('gitEnv', () => {
  it('keeps the git identity but no other GIT_* variable', () => {
    const env = gitEnv(source);
    expect(env.GIT_AUTHOR_NAME).toBe('Dev');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.CI).toBeUndefined();
  });
});
