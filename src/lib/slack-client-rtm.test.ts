import { afterEach, describe, expect, it } from 'bun:test';
import { SlackClient } from './slack-client.ts';
import { RateLimiter } from './rate-limiter.ts';
import type { WorkspaceConfig } from '../types/index.ts';

// openRtmSession() is the only place the RTM socket URL and its handshake
// headers are built: the session cookie must only ever go to a wss:// Slack host.

const browserConfig: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'browser',
  xoxd_token: 'xoxd-a/b+c=',
  xoxc_token: 'xoxc-test',
  workspace_url: 'https://acme.slack.com',
};

const standardConfig: WorkspaceConfig = {
  workspace_id: 'T123',
  workspace_name: 'Test Workspace',
  auth_type: 'standard',
  token: 'xoxb-test',
  token_type: 'bot',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function browserClient(answer: Record<string, unknown>): { client: SlackClient; methods: string[] } {
  const methods: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    methods.push(new URL(String(input)).pathname);
    return Response.json(answer);
  }) as unknown as typeof fetch;
  const client = new SlackClient(
    { ...browserConfig },
    { rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }), retry: { maxRetries: 0 } },
  );
  return { client, methods };
}

describe('SlackClient.openRtmSession', () => {
  it('calls rtm.connect and returns the socket URL with the browser cookie', async () => {
    const { client, methods } = browserClient({
      ok: true,
      url: 'wss://wss-primary.slack.com/websocket/abc?ticket=t',
      self: { id: 'U0123456789' },
    });
    const session = await client.openRtmSession();
    expect(methods).toEqual(['/api/rtm.connect']);
    expect(session).toEqual({
      url: 'wss://wss-primary.slack.com/websocket/abc?ticket=t',
      headers: { Cookie: 'd=xoxd-a%2Fb%2Bc%3D', Origin: 'https://app.slack.com' },
      selfId: 'U0123456789',
    });
  });

  it.each([
    ['a plain ws:// URL', 'ws://wss-primary.slack.com/websocket/abc'],
    ['an https:// URL', 'https://wss-primary.slack.com/websocket/abc'],
    ['a foreign host', 'wss://evil.example.com/websocket/abc'],
    ['a look-alike host', 'wss://slack.com.evil.example/websocket/abc'],
  ])('refuses %s, so the cookie never leaves Slack', async (_label, url) => {
    const { client } = browserClient({ ok: true, url });
    await expect(client.openRtmSession()).rejects.toThrow('not wss:// on a Slack host');
  });

  it.each([
    ['no url', {}],
    ['an unparseable url', { url: 'not a url' }],
  ])('fails clearly when rtm.connect returns %s', async (_label, extra) => {
    const { client } = browserClient({ ok: true, ...extra });
    await expect(client.openRtmSession()).rejects.toThrow('rtm.connect returned no socket URL');
  });

  it('sends no handshake headers for an app token', async () => {
    const client = new SlackClient({ ...standardConfig });
    (client as any).request = async (method: string) => {
      expect(method).toBe('rtm.connect');
      return { ok: true, url: 'wss://wss-primary.slack.com/websocket/abc' };
    };
    expect(await client.openRtmSession()).toEqual({
      url: 'wss://wss-primary.slack.com/websocket/abc',
      headers: {},
      selfId: undefined,
    });
  });
});
