import { afterEach, describe, expect, it } from 'bun:test';
import { childEnv } from './child-env.ts';

const TOKEN_VARS = ['SLACKCLI_TOKEN', 'SLACKCLI_XOXD', 'SLACKCLI_XOXC', 'SlackCli_Token'];

afterEach(() => {
  for (const key of TOKEN_VARS) delete process.env[key];
});

describe('childEnv', () => {
  // Assert against the values this test planted, never against a serialization
  // of the whole inherited environment: an unrelated variable on a real machine
  // can contain the sentinel string (`NOTION_TOKEN=secret_...` is enough), and
  // when such an assertion fails the runner prints every environment variable
  // the developer has exported — turning a red test into a credential dump.
  it('removes slackcli token variables', () => {
    process.env.SLACKCLI_TOKEN = 'xoxb-planted-token';
    process.env.SLACKCLI_XOXD = 'xoxd-planted-token';
    process.env.SLACKCLI_XOXC = 'xoxc-planted-token';

    const env = childEnv();

    expect(env.SLACKCLI_TOKEN).toBeUndefined();
    expect(env.SLACKCLI_XOXD).toBeUndefined();
    expect(env.SLACKCLI_XOXC).toBeUndefined();
    const values = Object.values(env);
    expect(values).not.toContain('xoxb-planted-token');
    expect(values).not.toContain('xoxd-planted-token');
    expect(values).not.toContain('xoxc-planted-token');
  });

  it('removes them regardless of case (Windows env vars are case-insensitive)', () => {
    process.env.SlackCli_Token = 'xoxb-planted-token';

    expect(Object.values(childEnv())).not.toContain('xoxb-planted-token');
  });

  it('preserves everything the helper processes actually need', () => {
    process.env.SLACKCLI_TOKEN = 'xoxb-planted-token';

    const env = childEnv();

    // PATH/HOME and the display vars xclip and the browser depend on.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    // Only the token vars are dropped — counted against the parent's own
    // token vars, so a developer who exports SLACKCLI_XOXD does not fail this.
    const parentTokenVars = Object.keys(process.env).filter((k) =>
      ['SLACKCLI_TOKEN', 'SLACKCLI_XOXD', 'SLACKCLI_XOXC'].includes(k.toUpperCase())
    ).length;
    expect(Object.keys(env).length).toBe(Object.keys(process.env).length - parentTokenVars);
  });

  it('does not mutate the parent environment', () => {
    process.env.SLACKCLI_TOKEN = 'xoxb-planted-token';

    childEnv();

    expect(process.env.SLACKCLI_TOKEN).toBe('xoxb-planted-token');
  });
});
