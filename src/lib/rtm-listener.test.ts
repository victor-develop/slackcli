import { afterEach, describe, expect, it } from 'bun:test';
import {
  connectRtmSocket,
  isFatalListenError,
  parseChannelFilter,
  runListener,
  toListenEvent,
  type ListenEvent,
  type RtmSocket,
  type WebSocketFactory,
} from './rtm-listener.ts';
import { RtmSessionError, SlackClient, SlackTransportError } from './slack-client.ts';
import { RateLimiter } from './rate-limiter.ts';
import { InvalidInputError } from './cli-errors.ts';
import type { WorkspaceConfig } from '../types/index.ts';

// The listener is tested through the RtmSocket seam, and connectRtmSocket
// through an injected WebSocket factory (see cdp-client.test.ts for the same
// pattern), so nothing here talks to Slack.

class FakeSocket implements RtmSocket {
  sent: string[] = [];
  closeCalls = 0;
  closed = false;
  /** When false, close() is ignored, like a half-open TCP connection. */
  answersClose = true;
  private messageHandler?: (data: string) => void;
  private closeHandler?: (code: number) => void;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls++;
    if (this.answersClose) this.finish(1000);
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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step = FakeSocket | Error | ((signal?: AbortSignal) => Promise<RtmSocket>);

/** Collects emitted lines and records every backoff the listener asks for. */
function harness(script: Step[]) {
  const events: ListenEvent[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  let connects = 0;
  const connect = async (signal?: AbortSignal) => {
    const next = script[connects++];
    if (next === undefined) {
      controller.abort();
      throw new Error('script exhausted');
    }
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(signal);
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
      subtype: 'bot_message',
      text: '',
      attachments: [{ pretext: 'p', title: 't', text: 'x', fallback: 'f' }],
      files: [{ id: 'F1', name: 'a.png', filetype: 'png' }],
    });
  });

  it('prefers an explicit username over the bot profile name', () => {
    expect(toListenEvent({ type: 'message', channel: 'C1', ts: '1.2', username: 'hook', bot_profile: { name: 'x' } }))
      .toMatchObject({ username: 'hook' });
  });

  it('emits an edit as the edited message with its new text', () => {
    expect(toListenEvent({
      type: 'message',
      subtype: 'message_changed',
      hidden: true,
      channel: 'C1',
      ts: '9.9',
      message: { ts: '1.2', thread_ts: '1.0', user: 'U1', text: 'fixed typo' },
      previous_message: { ts: '1.2', text: 'fixd typo' },
    })).toEqual({
      type: 'message',
      channel: 'C1',
      ts: '1.2',
      thread_ts: '1.0',
      user: 'U1',
      username: undefined,
      bot_id: undefined,
      subtype: 'message_changed',
      text: 'fixed typo',
      attachments: [],
      files: [],
    });
  });

  it('emits a deletion with the deleted ts and no text', () => {
    expect(toListenEvent({
      type: 'message',
      subtype: 'message_deleted',
      hidden: true,
      channel: 'C1',
      ts: '9.9',
      deleted_ts: '1.2',
      previous_message: { ts: '1.2', thread_ts: '1.0', text: 'gone' },
    })).toMatchObject({ channel: 'C1', ts: '1.2', thread_ts: '1.0', subtype: 'message_deleted', text: '' });
  });

  it('falls back to previous_message.ts for a deletion without deleted_ts', () => {
    expect(toListenEvent({ type: 'message', subtype: 'message_deleted', channel: 'C1', previous_message: { ts: '1.2' } }))
      .toMatchObject({ ts: '1.2', subtype: 'message_deleted' });
  });

  it.each([
    ['not a message', { type: 'user_typing', channel: 'C1', ts: '1.2' }],
    ['other hidden bookkeeping', { type: 'message', subtype: 'channel_join', channel: 'C1', ts: '1.2', hidden: true }],
    ['no channel', { type: 'message', ts: '1.2' }],
    ['no ts', { type: 'message', channel: 'C1' }],
    ['a non-string channel', { type: 'message', channel: 5, ts: '1.2' }],
    ['an edit without the edited message', { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '9.9' }],
    ['a deletion without any ts', { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '9.9' }],
    ['null', null],
    ['a string', 'message'],
  ])('drops %s', (_label, raw) => {
    expect(toListenEvent(raw)).toBeNull();
  });

  it('treats a non-string text as empty and tolerates malformed lists', () => {
    expect(toListenEvent({ type: 'message', channel: 'C1', ts: '1.2', text: 42, attachments: 'x', files: {} }))
      .toMatchObject({ text: '', attachments: [], files: [] });
  });

  it('applies the channel filter to messages, edits and deletions; an empty filter keeps everything', () => {
    const raw = { type: 'message', channel: 'C1', ts: '1.2' };
    expect(toListenEvent(raw, new Set(['C2']))).toBeNull();
    expect(toListenEvent(raw, new Set(['C1', 'C2']))).not.toBeNull();
    expect(toListenEvent(raw, new Set())).not.toBeNull();
    expect(toListenEvent({ ...raw, subtype: 'message_changed', message: { ts: '1.2' } }, new Set(['C2']))).toBeNull();
    expect(toListenEvent({ ...raw, subtype: 'message_deleted', deleted_ts: '1.2' }, new Set(['C2']))).toBeNull();
  });
});

describe('parseChannelFilter', () => {
  it('returns no filter when the option is absent', () => {
    expect(parseChannelFilter(undefined)).toBeUndefined();
  });

  it('splits, trims and de-duplicates IDs', () => {
    const filter = parseChannelFilter(' C0123456789 ,D0123456789,C0123456789 ')!;
    expect([...filter.ids]).toEqual(['C0123456789', 'D0123456789']);
    expect(filter.linkWorkspaces).toEqual([]);
  });

  it('accepts Slack links and keeps their workspace for the mismatch warning', () => {
    const filter = parseChannelFilter(
      'https://acme.slack.com/archives/C0123456789,https://acme.slack.com/archives/C0223456789,C0323456789',
    )!;
    expect([...filter.ids]).toEqual(['C0123456789', 'C0223456789', 'C0323456789']);
    expect(filter.linkWorkspaces).toEqual(['acme']);
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

  it('is fatal for an rtm.connect reply the CLI refuses to use', () => {
    expect(isFatalListenError(new RtmSessionError('not wss'))).toBe(true);
  });

  it('is not fatal for a network failure, a rate limit or a socket failure', () => {
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
    first.receive({ type: 'error', error: { code: 1, msg: 'x' } });
    first.receive('not json');
    first.finish(1006);
    await done;
    expect(h.events.map((e) => e.type)).toEqual(['hello', 'message']);
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

  it('waits 1 s first, doubles on every reconnect and caps at the maximum', async () => {
    const h = harness([new Error('a'), new Error('b'), new Error('c'), new Error('d'), new Error('e')]);
    await h.run({ minBackoffMs: 100, maxBackoffMs: 500 });
    expect(h.sleeps).toEqual([100, 200, 400, 500, 500]);
  });

  it('keeps backing off when Slack accepts and drops every connection', async () => {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    const h = harness(sockets);
    const done = h.run({ minBackoffMs: 100, maxBackoffMs: 10_000, stableAfterMs: 60_000 });
    for (const socket of sockets) {
      for (let i = 0; i < 10 && h.connects() <= sockets.indexOf(socket); i++) await tick();
      await tick(); // let runSocket attach its handlers
      socket.receive({ type: 'hello' });
      socket.finish(1006);
    }
    await done;
    expect(h.sleeps).toEqual([100, 200, 400]);
  });

  it('resets the backoff once a socket stayed up past stableAfterMs', async () => {
    let clock = 0;
    const stable = new FakeSocket();
    const h = harness([new Error('a'), new Error('b'), stable]);
    const done = h.run({ minBackoffMs: 100, maxBackoffMs: 10_000, stableAfterMs: 1_000, now: () => clock });
    for (let i = 0; i < 10 && h.connects() < 3; i++) await tick();
    await tick();
    stable.receive({ type: 'hello' });
    clock += 1_000;
    stable.finish(1006);
    await done;
    expect(h.sleeps).toEqual([100, 200, 100]);
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

  it('closes a socket that finished opening after an abort, instead of hanging', async () => {
    const late = new FakeSocket();
    let release!: () => void;
    const opening = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([async () => { await opening; return late; }]);
    const done = h.run();
    await tick();
    h.controller.abort();
    release();
    await done;
    expect(late.closed).toBe(true);
    expect(h.connects()).toBe(1);
  });

  it('passes the abort signal to connect', async () => {
    let seen: AbortSignal | undefined;
    const h = harness([async (signal) => { seen = signal; throw new Error('x'); }]);
    await h.run();
    expect(seen).toBe(h.controller.signal);
  });

  it('does not connect at all when already aborted', async () => {
    const h = harness([new FakeSocket()]);
    h.controller.abort();
    await h.run();
    expect(h.connects()).toBe(0);
  });

  it('gives up on a close that is never confirmed', async () => {
    const halfOpen = new FakeSocket();
    halfOpen.answersClose = false;
    const h = harness([halfOpen]);
    const done = h.run({ closeGraceMs: 20 });
    await tick();
    halfOpen.receive({ type: 'hello' });
    h.controller.abort();
    await done;
    expect(halfOpen.closeCalls).toBe(1);
    expect(halfOpen.closed).toBe(false);
  });

  it('pings while frames keep arriving and closes an idle connection', async () => {
    const socket = new FakeSocket();
    const h = harness([socket]);
    const done = h.run({ pingIntervalMs: 10, idleTimeoutMs: 35 });
    await tick();
    socket.receive({ type: 'hello' });
    await wait(25);
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ id: 1, type: 'ping' });
    expect(socket.closed).toBe(false);
    await done;
    expect(socket.closed).toBe(true);
  });

  it('closes the socket when a ping cannot be sent', async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error('socket gone');
    };
    const h = harness([socket]);
    await h.run({ pingIntervalMs: 5, idleTimeoutMs: 1_000 });
    expect(socket.closed).toBe(true);
  });
});

/** A scripted WebSocket the test drives by hand. */
function fakeWebSocket() {
  const state = {
    url: '',
    headers: {} as Record<string, string>,
    closeCalls: 0,
    sent: [] as string[],
    ws: undefined as any,
  };
  const factory: WebSocketFactory = (url, headers) => {
    state.url = url;
    state.headers = headers;
    state.ws = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: (data: string) => state.sent.push(data),
      close: () => { state.closeCalls++; },
    };
    return state.ws;
  };
  return { state, factory };
}

describe('connectRtmSocket', () => {
  const session = { url: 'wss://wss-primary.slack.com/websocket/abc', headers: { Cookie: 'd=x' } };

  it('opens with the session URL and headers and relays frames and close', async () => {
    const { state, factory } = fakeWebSocket();
    const pending = connectRtmSocket(session, { factory });
    expect(state.url).toBe(session.url);
    expect(state.headers).toEqual({ Cookie: 'd=x' });
    state.ws.onopen({});
    const socket = await pending;

    const frames: string[] = [];
    socket.onMessage((data) => frames.push(data));
    state.ws.onmessage({ data: '{"type":"hello"}' });
    state.ws.onmessage({ data: new ArrayBuffer(4) });
    expect(frames).toEqual(['{"type":"hello"}']);

    socket.send('ping');
    expect(state.sent).toEqual(['ping']);

    const codes: number[] = [];
    socket.onClose((code) => codes.push(code));
    state.ws.onclose({ code: 1001 });
    state.ws.onclose({ code: 1006 });
    expect(codes).toEqual([1001]);
  });

  it('reports a close that happened before onClose was registered', async () => {
    const { state, factory } = fakeWebSocket();
    const pending = connectRtmSocket(session, { factory });
    state.ws.onopen({});
    const socket = await pending;
    state.ws.onclose({ code: 1000 });
    const codes: number[] = [];
    socket.onClose((code) => codes.push(code));
    expect(codes).toEqual([1000]);
  });

  it('ignores an error after the socket opened (the close event follows)', async () => {
    const { state, factory } = fakeWebSocket();
    const pending = connectRtmSocket(session, { factory });
    state.ws.onopen({});
    await pending;
    state.ws.onerror({});
    expect(state.closeCalls).toBe(0);
  });

  it('rejects when the handshake fails', async () => {
    const { state, factory } = fakeWebSocket();
    const pending = connectRtmSocket(session, { factory });
    state.ws.onerror({});
    await expect(pending).rejects.toThrow('Could not open the RTM socket');
    expect(state.closeCalls).toBe(1);
  });

  it('rejects when the socket closes during the handshake', async () => {
    const { state, factory } = fakeWebSocket();
    const pending = connectRtmSocket(session, { factory });
    state.ws.onclose({ code: 1006 });
    await expect(pending).rejects.toThrow('closed during the handshake');
  });

  it('rejects and closes when it does not open in time', async () => {
    const { state, factory } = fakeWebSocket();
    await expect(connectRtmSocket(session, { factory, timeoutMs: 10 })).rejects.toThrow('did not open within 10ms');
    expect(state.closeCalls).toBe(1);
  });

  it('rejects and closes when aborted while opening', async () => {
    const { state, factory } = fakeWebSocket();
    const controller = new AbortController();
    const pending = connectRtmSocket(session, { factory, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('Stopped before the RTM socket opened');
    expect(state.closeCalls).toBe(1);
    // A late open after the abort changes nothing.
    state.ws.onopen({});
  });

  it('does not open at all when already aborted', async () => {
    const { state, factory } = fakeWebSocket();
    const controller = new AbortController();
    controller.abort();
    await expect(connectRtmSocket(session, { factory, signal: controller.signal })).rejects.toThrow('Stopped');
    expect(state.url).toBe('');
  });
});
