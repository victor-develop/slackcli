import { afterEach, describe, expect, it } from 'bun:test';
import {
  isFatalListenError,
  parseChannelFilter,
  runListener,
  toListenEvent,
  type ListenEvent,
  type RtmSocket,
} from './rtm-listener.ts';
import { SlackClient, SlackTransportError } from './slack-client.ts';
import { RateLimiter } from './rate-limiter.ts';
import { InvalidInputError } from './cli-errors.ts';
import type { WorkspaceConfig } from '../types/index.ts';

// The listener is tested through the RtmSocket seam; connectRtmSocket is the
// untestable transport edge (see cdp-client.test.ts for the same pattern).

class FakeSocket implements RtmSocket {
  sent: string[] = [];
  closed = false;
  private messageHandler?: (data: string) => void;
  private closeHandler?: (code: number) => void;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.finish(1000);
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (code: number) => void): void {
    this.closeHandler = handler;
  }
  /** A frame from Slack. */
  receive(frame: unknown): void {
    this.messageHandler?.(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
  /** The connection ends (peer close, network drop or our own close()). */
  finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(code);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Collects emitted lines and records every backoff the listener asks for. */
function harness(script: Array<FakeSocket | Error>) {
  const events: ListenEvent[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  let connects = 0;
  const connect = async () => {
    const next = script[connects++];
    if (next === undefined) {
      controller.abort();
      throw new Error('script exhausted');
    }
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return {
    events,
    sleeps,
    controller,
    connects: () => connects,
    run: (extra: Record<string, unknown> = {}) =>
      runListener({ connect, emit: (e) => events.push(e), signal: controller.signal, sleep, ...extra }),
  };
}

describe('toListenEvent', () => {
  it('maps a message event to the documented line shape', () => {
    expect(toListenEvent({
      type: 'message',
      channel: 'C0123456789',
      ts: '1700000000.000100',
      thread_ts: '1700000000.000001',
      user: 'U0123456789',
      text: 'hello',
      team: 'T0123456789',
      blocks: [{ type: 'rich_text' }],
    })).toEqual({
      type: 'message',
      channel: 'C0123456789',
      ts: '1700000000.000100',
      thread_ts: '1700000000.000001',
      user: 'U0123456789',
      username: undefined,
      bot_id: undefined,
      subtype: undefined,
      text: 'hello',
      attachments: [],
      files: [],
    });
  });

  it('keeps only the readable attachment keys and the file identity', () => {
    const event = toListenEvent({
      type: 'message',
      channel: 'C1',
      ts: '1.2',
      bot_id: 'B1',
      bot_profile: { name: 'ci-bot' },
      subtype: 'bot_message',
      attachments: [{ pretext: 'p', title: 't', text: 'x', fallback: 'f', color: '#fff', actions: [{}] }],
      files: [{ id: 'F1', name: 'a.png', filetype: 'png', url_private: 'https://files.slack.com/secret' }],
    });
    expect(event).toMatchObject({
      username: 'ci-bot',
      bot_id: 'B1',
      text: '',
      attachments: [{ pretext: 'p', title: 't', text: 'x', fallback: 'f' }],
      files: [{ id: 'F1', name: 'a.png', filetype: 'png' }],
    });
  });

  it('prefers an explicit username over the bot profile name', () => {
    expect(toListenEvent({ type: 'message', channel: 'C1', ts: '1.2', username: 'hook', bot_profile: { name: 'x' } }))
      .toMatchObject({ username: 'hook' });
  });

  it.each([
    ['not a message', { type: 'user_typing', channel: 'C1', ts: '1.2' }],
    ['hidden bookkeeping', { type: 'message', channel: 'C1', ts: '1.2', hidden: true }],
    ['no channel', { type: 'message', ts: '1.2' }],
    ['no ts', { type: 'message', channel: 'C1' }],
    ['a non-string channel', { type: 'message', channel: 5, ts: '1.2' }],
    ['null', null],
    ['a string', 'message'],
  ])('drops %s', (_label, raw) => {
    expect(toListenEvent(raw)).toBeNull();
  });

  it('treats a non-string text as empty and tolerates malformed lists', () => {
    expect(toListenEvent({ type: 'message', channel: 'C1', ts: '1.2', text: 42, attachments: 'x', files: {} }))
      .toMatchObject({ text: '', attachments: [], files: [] });
  });

  it('applies the channel filter, and an empty filter keeps everything', () => {
    const raw = { type: 'message', channel: 'C1', ts: '1.2' };
    expect(toListenEvent(raw, new Set(['C2']))).toBeNull();
    expect(toListenEvent(raw, new Set(['C1', 'C2']))).not.toBeNull();
    expect(toListenEvent(raw, new Set())).not.toBeNull();
  });
});

describe('parseChannelFilter', () => {
  it('returns no filter when the option is absent', () => {
    expect(parseChannelFilter(undefined)).toBeUndefined();
  });

  it('splits, trims and de-duplicates IDs', () => {
    expect([...parseChannelFilter(' C0123456789 ,D0123456789,C0123456789 ')!]).toEqual(['C0123456789', 'D0123456789']);
  });

  it('accepts Slack links', () => {
    expect([...parseChannelFilter('https://acme.slack.com/archives/C0123456789')!]).toEqual(['C0123456789']);
  });

  it.each(['', ' , ,'])('refuses an empty list (%p)', (value) => {
    expect(() => parseChannelFilter(value)).toThrow(InvalidInputError);
  });
});

describe('isFatalListenError', () => {
  const browserConfig: WorkspaceConfig = {
    workspace_id: 'T123',
    workspace_name: 'Test Workspace',
    auth_type: 'browser',
    xoxd_token: 'xoxd-test',
    xoxc_token: 'xoxc-test',
    workspace_url: 'https://acme.slack.com',
  };
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function slackFailure(body: Record<string, unknown>): Promise<unknown> {
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
    const client = new SlackClient(browserConfig, {
      rateLimiter: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 }),
      retry: { maxRetries: 0 },
    });
    try {
      await client.request('rtm.connect', {});
    } catch (err) {
      return err;
    }
    throw new Error('expected the call to fail');
  }

  it('is fatal for a dead session', async () => {
    expect(isFatalListenError(await slackFailure({ ok: false, error: 'invalid_auth' }))).toBe(true);
  });

  it('is fatal for a token Slack refuses on RTM', async () => {
    expect(isFatalListenError(await slackFailure({ ok: false, error: 'not_allowed_token_type' }))).toBe(true);
  });

  it('is fatal for any other code Slack answers with', async () => {
    expect(isFatalListenError(await slackFailure({ ok: false, error: 'some_new_code' }))).toBe(true);
  });

  it('is not fatal for a network failure, a rate limit or a plain error', () => {
    expect(isFatalListenError(new SlackTransportError('down', undefined, undefined, true))).toBe(false);
    expect(isFatalListenError(new SlackTransportError('slow down', 429, 1000, false))).toBe(false);
    expect(isFatalListenError(new Error('Could not open the RTM socket'))).toBe(false);
  });
});

describe('runListener', () => {
  it('emits hello and messages, then reconnects after the socket closes', async () => {
    const first = new FakeSocket();
    const h = harness([first]);
    const done = h.run();
    await tick();
    first.receive({ type: 'hello' });
    first.receive({ type: 'message', channel: 'C1', ts: '1.1', text: 'a' });
    first.receive({ type: 'reconnect_url', url: 'wss://x.slack.com/ignored' });
    first.receive('not json');
    first.finish(1006);
    await done;
    expect(h.events.map((e) => e.type)).toEqual(['hello', 'message']);
    // Healthy socket: back to the minimum backoff, then a second connect.
    expect(h.sleeps[0]).toBe(1_000);
    expect(h.connects()).toBe(2);
  });

  it('only emits messages from the filtered channels', async () => {
    const socket = new FakeSocket();
    const h = harness([socket]);
    const done = h.run({ channels: new Set(['C2']) });
    await tick();
    socket.receive({ type: 'hello' });
    socket.receive({ type: 'message', channel: 'C1', ts: '1.1' });
    socket.receive({ type: 'message', channel: 'C2', ts: '1.2' });
    socket.finish(1000);
    await done;
    expect(h.events).toEqual([{ type: 'hello' }, expect.objectContaining({ channel: 'C2' })]);
  });

  it('closes on goodbye so the loop reconnects', async () => {
    const socket = new FakeSocket();
    const h = harness([socket]);
    const done = h.run();
    await tick();
    socket.receive({ type: 'hello' });
    socket.receive({ type: 'goodbye' });
    await done;
    expect(socket.closed).toBe(true);
    expect(h.connects()).toBe(2);
  });

  it('doubles the backoff on consecutive failures up to the cap, and resets after hello', async () => {
    const healthy = new FakeSocket();
    const h = harness([new Error('a'), new Error('b'), new Error('c'), new Error('d'), healthy, new Error('e')]);
    const done = h.run({ minBackoffMs: 100, maxBackoffMs: 500 });
    for (let i = 0; i < 10 && h.connects() < 5; i++) await tick();
    healthy.receive({ type: 'hello' });
    healthy.finish(1006);
    await done;
    expect(h.sleeps).toEqual([200, 400, 500, 500, 100, 200]);
  });

  it('does not reset the backoff when a socket closes before hello', async () => {
    const silent = new FakeSocket();
    const h = harness([new Error('a'), silent]);
    const done = h.run({ minBackoffMs: 100, maxBackoffMs: 1_000 });
    for (let i = 0; i < 10 && h.connects() < 2; i++) await tick();
    silent.finish(1006);
    await done;
    expect(h.sleeps.slice(0, 2)).toEqual([200, 400]);
  });

  it('rethrows a fatal error instead of retrying', async () => {
    const fatal = Object.assign(new Error('Slack API error: not_allowed_token_type'), {
      slackData: { ok: false, error: 'not_allowed_token_type' },
    });
    const h = harness([fatal, new FakeSocket()]);
    await expect(h.run()).rejects.toBe(fatal);
    expect(h.connects()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('stops and closes the socket when aborted', async () => {
    const socket = new FakeSocket();
    const h = harness([socket, new FakeSocket()]);
    const done = h.run();
    await tick();
    socket.receive({ type: 'hello' });
    h.controller.abort();
    await done;
    expect(socket.closed).toBe(true);
    expect(h.connects()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('does not connect at all when already aborted', async () => {
    const h = harness([new FakeSocket()]);
    h.controller.abort();
    await h.run();
    expect(h.connects()).toBe(0);
  });

  it('pings while frames keep arriving and closes an idle connection', async () => {
    const socket = new FakeSocket();
    const h = harness([socket]);
    const done = h.run({ pingIntervalMs: 10, idleTimeoutMs: 35 });
    await tick();
    socket.receive({ type: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ id: 1, type: 'ping' });
    expect(socket.closed).toBe(false);
    // No more frames: the idle check closes the socket.
    await done;
    expect(socket.closed).toBe(true);
  });

  it('closes the socket when a ping cannot be sent', async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error('socket gone');
    };
    const h = harness([socket]);
    const done = h.run({ pingIntervalMs: 5, idleTimeoutMs: 1_000 });
    await done;
    expect(socket.closed).toBe(true);
  });
});
