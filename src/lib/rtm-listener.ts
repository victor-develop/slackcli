/**
 * Stream incoming Slack messages over the real-time messaging (RTM) socket.
 *
 * `runListener` holds every decision — which events to emit, keepalive,
 * reconnect and backoff — and is driven through the `RtmSocket` seam so it
 * unit-tests without Slack. `connectRtmSocket` is the transport edge (Bun's
 * built-in WebSocket, so no dependency); the WebSocket constructor is
 * injectable so its open / close / timeout branches are tested too, like
 * `connectCdpSocket` in cdp-client.ts.
 *
 * Logging records connects, close codes, counts and durations only. The socket
 * URL carries a one-time ticket and events carry message text, so neither is
 * ever logged.
 */

import { getLogger } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';
import { classifyError } from './command-errors.ts';
import { RtmSessionError } from './slack-client.ts';
import { normalizeIdentifier, workspaceOf } from './slack-url-parser.ts';
import { errorMessageForLog } from './tildify.ts';

const logger = getLogger(['slackcli', 'rtm']);

/** Transport seam. Mirrors the slice of WebSocket the listener uses. */
export interface RtmSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  /** Fires once, whether the peer closed, the network dropped or close() was called. */
  onClose(handler: (code: number) => void): void;
}

/** One line of `messages listen` output. */
export type ListenEvent =
  | { type: 'hello' }
  | {
      type: 'message';
      channel: string;
      ts: string;
      thread_ts?: string;
      user?: string;
      username?: string;
      bot_id?: string;
      subtype?: string;
      text: string;
      attachments: Array<Record<string, unknown>>;
      files: Array<{ id?: string; name?: string; filetype?: string }>;
    };

/** `--channels`, parsed: the IDs, plus the workspace host of every link given. */
export interface ChannelFilter {
  ids: Set<string>;
  linkWorkspaces: string[];
}

/**
 * Parse `--channels`: comma-separated channel or DM IDs, or Slack links to
 * them. Undefined means no filter; a value with no ID in it is refused.
 * Duplicates collapse. The workspace of each link is kept so the command can
 * warn when it points at another workspace.
 */
export function parseChannelFilter(value?: string): ChannelFilter | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new InvalidInputError('--channels needs at least one channel ID.');
  const linkWorkspaces = parts.map((part) => workspaceOf(part)).filter((w): w is string => Boolean(w));
  return {
    ids: new Set(parts.map((part) => normalizeIdentifier(part, 'channel', '--channels'))),
    linkWorkspaces: [...new Set(linkWorkspaces)],
  };
}

const ATTACHMENT_KEYS = ['pretext', 'title', 'text', 'fallback', 'author_name'] as const;

function messageLine(channel: string, source: any, subtype?: string): ListenEvent {
  const attachments = Array.isArray(source?.attachments) ? source.attachments : [];
  const files = Array.isArray(source?.files) ? source.files : [];
  return {
    type: 'message',
    channel,
    ts: source.ts,
    thread_ts: source.thread_ts,
    user: source.user,
    username: source.username ?? source.bot_profile?.name,
    bot_id: source.bot_id,
    subtype,
    text: typeof source.text === 'string' ? source.text : '',
    attachments: attachments.map((a: any) =>
      Object.fromEntries(ATTACHMENT_KEYS.filter((k) => a?.[k] !== undefined).map((k) => [k, a[k]]))),
    files: files.map((f: any) => ({ id: f?.id, name: f?.name, filetype: f?.filetype })),
  };
}

/**
 * Turn a raw RTM event into a `message` line, or null when it is not one we
 * emit: not a message, missing channel or ts, outside the `channels` filter,
 * or a hidden event (Slack's own bookkeeping).
 *
 * Edits and deletions are hidden events too, but they are emitted: an edit as
 * the edited message (its own ts, the new text) with subtype
 * `message_changed`, a deletion as `message_deleted` with the deleted
 * message's ts and empty text.
 */
export function toListenEvent(raw: any, channels?: ReadonlySet<string>): ListenEvent | null {
  if (!raw || typeof raw !== 'object' || raw.type !== 'message') return null;
  if (typeof raw.channel !== 'string') return null;
  if (channels && channels.size > 0 && !channels.has(raw.channel)) return null;

  if (raw.subtype === 'message_changed') {
    const edited = raw.message;
    if (!edited || typeof edited.ts !== 'string') return null;
    return messageLine(raw.channel, edited, 'message_changed');
  }
  if (raw.subtype === 'message_deleted') {
    const ts = typeof raw.deleted_ts === 'string' ? raw.deleted_ts : raw.previous_message?.ts;
    if (typeof ts !== 'string') return null;
    return messageLine(raw.channel, { ts, thread_ts: raw.previous_message?.thread_ts }, 'message_deleted');
  }

  if (raw.hidden || typeof raw.ts !== 'string') return null;
  return messageLine(raw.channel, raw, raw.subtype);
}

/**
 * Errors that reconnecting cannot fix: a dead session, a token Slack does not
 * allow on RTM, an rtm.connect reply the CLI refuses to use, or any other
 * answer Slack gave with a code that is not retryable. A failure with no Slack
 * answer (network, socket handshake) is not fatal and is retried. Classified
 * by type, never by message.
 */
export function isFatalListenError(err: unknown): boolean {
  if (err instanceof RtmSessionError) return true;
  const classified = classifyError(err);
  if (classified.retryable) return false;
  return classified.code !== 'unknown' || classified.slack_error !== undefined;
}

export interface ListenerOptions {
  /** Open a fresh socket: rtm.connect, then the WebSocket handshake. */
  connect: (signal?: AbortSignal) => Promise<RtmSocket>;
  /** Receives every output line, in order. */
  emit: (event: ListenEvent) => void;
  channels?: ReadonlySet<string>;
  /** Stops the listener: closes the socket and resolves. */
  signal?: AbortSignal;
  pingIntervalMs?: number;
  /** No frame at all for this long means the connection is dead. */
  idleTimeoutMs?: number;
  /** After close() is asked for, wait this long for the close event before giving up on it. */
  closeGraceMs?: number;
  /** A socket that stayed up this long after hello resets the backoff. */
  stableAfterMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const PING_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const STABLE_AFTER_MS = 60_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** How one socket ended: whether Slack said hello, and how long it stayed up after. */
interface SocketOutcome {
  gotHello: boolean;
  upAfterHelloMs: number;
}

/**
 * Run one socket until it closes. If a close is asked for (abort, idle,
 * goodbye, a failed ping) and the close event does not follow within
 * `closeGraceMs` — a half-open TCP connection never answers the close
 * handshake — it resolves anyway, so the listener can stop or reconnect.
 */
function runSocket(socket: RtmSocket, options: ListenerOptions): Promise<SocketOutcome> {
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  const now = options.now ?? Date.now;

  return new Promise((resolve) => {
    let helloAt: number | undefined;
    let lastFrameAt = now();
    let pingId = 0;
    let finished = false;
    let emitted = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearInterval(pingTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', closeSocket);
      logger.info('RTM socket closed, code {code}, {count} messages emitted', { code, count: emitted });
      resolve({ gotHello: helloAt !== undefined, upAfterHelloMs: helloAt === undefined ? 0 : now() - helloAt });
    };

    function closeSocket() {
      if (finished || graceTimer) return;
      graceTimer = setTimeout(() => {
        logger.warn('RTM socket did not confirm the close within {grace_ms} ms', { grace_ms: closeGraceMs });
        finish(1006);
      }, closeGraceMs);
      try {
        socket.close();
      } catch {
        // already gone
      }
    }

    const pingTimer = setInterval(() => {
      if (now() - lastFrameAt > idleTimeoutMs) {
        logger.warn('No frame from Slack for {idle_ms} ms, reconnecting', { idle_ms: idleTimeoutMs });
        closeSocket();
        return;
      }
      try {
        socket.send(JSON.stringify({ id: ++pingId, type: 'ping' }));
      } catch {
        closeSocket();
      }
    }, pingIntervalMs);

    socket.onClose(finish);
    socket.onMessage((data) => {
      lastFrameAt = now();
      let raw: any;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      if (raw?.type === 'hello') {
        helloAt = now();
        logger.info('RTM socket ready');
        options.emit({ type: 'hello' });
      } else if (raw?.type === 'goodbye') {
        logger.info('Slack asked to reconnect (goodbye)');
        closeSocket();
      } else if (raw?.type === 'error') {
        logger.warn('RTM error frame, code {code}', { code: raw?.error?.code });
      } else {
        const event = toListenEvent(raw, options.channels);
        if (event) {
          emitted++;
          options.emit(event);
        }
      }
    });

    // Aborted while connect() was still running: close straight away.
    if (options.signal?.aborted) closeSocket();
    else options.signal?.addEventListener('abort', closeSocket, { once: true });
  });
}

/**
 * Listen until `signal` aborts. Reconnects after every close. The wait starts
 * at minBackoffMs and doubles on each reconnect, up to maxBackoffMs; it goes
 * back to the minimum only after a socket stayed up for `stableAfterMs` past
 * its hello, so a Slack that accepts and then drops every connection is not
 * hit once a second. A fatal error (`isFatalListenError`) is rethrown instead
 * of retried.
 */
export async function runListener(options: ListenerOptions): Promise<void> {
  const minBackoff = options.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  const stableAfter = options.stableAfterMs ?? STABLE_AFTER_MS;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  let backoff = minBackoff;

  while (!options.signal?.aborted) {
    try {
      const startedAt = now();
      const socket = await options.connect(options.signal);
      logger.debug('RTM socket opened in {duration_ms} ms', { duration_ms: now() - startedAt });
      const outcome = await runSocket(socket, options);
      if (outcome.gotHello && outcome.upAfterHelloMs >= stableAfter) backoff = minBackoff;
    } catch (err) {
      if (isFatalListenError(err)) throw err;
      logger.warn('RTM connect failed: {error}', { error: errorMessageForLog(err) });
    }
    if (options.signal?.aborted) break;
    await sleep(backoff, options.signal);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}

/** The slice of the WebSocket constructor `connectRtmSocket` uses (a test seam). */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
};

// Bun's WebSocket takes handshake headers as a second-argument option. It does
// not follow a redirect on the handshake (checked on Bun 1.4: a 302 fails the
// connection without contacting the target), so the cookie that
// openRtmSession() only builds for a wss:// Slack host cannot be carried off it.
const bunWebSocket: WebSocketFactory = (url, headers) => new WebSocket(url, { headers } as any) as any;

/**
 * Open the RTM WebSocket. Rejects if it does not open within `timeoutMs`, if
 * the handshake fails, or if `signal` aborts first.
 */
export function connectRtmSocket(
  session: { url: string; headers: Record<string, string> },
  options: { timeoutMs?: number; signal?: AbortSignal; factory?: WebSocketFactory } = {},
): Promise<RtmSocket> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Stopped before the RTM socket opened'));
    let settled = false;
    const ws = (options.factory ?? bunWebSocket)(session.url, session.headers);
    let closeHandler: ((code: number) => void) | undefined;
    let closeCode: number | undefined;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        // nothing to release
      }
      reject(new Error(message));
    };
    const onAbort = () => fail('Stopped before the RTM socket opened');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => fail(`RTM socket did not open within ${timeoutMs}ms`), timeoutMs);

    ws.onclose = (ev) => {
      if (!settled) return fail('RTM socket closed during the handshake');
      if (closeCode !== undefined) return;
      closeCode = ev.code;
      closeHandler?.(ev.code);
    };
    ws.onerror = () => fail('Could not open the RTM socket');
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (handler) => {
          ws.onmessage = (ev) => {
            // RTM only sends text frames; a binary frame is not an event.
            if (typeof ev.data === 'string') handler(ev.data);
          };
        },
        onClose: (handler) => {
          closeHandler = handler;
          if (closeCode !== undefined) handler(closeCode);
        },
      });
    };
  });
}
