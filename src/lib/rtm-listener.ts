/**
 * Stream incoming Slack messages over the real-time messaging (RTM) socket.
 *
 * `runListener` holds every decision — which events to emit, keepalive,
 * reconnect and backoff — and is driven through the `RtmSocket` seam so it
 * unit-tests without Slack. `connectRtmSocket` is the transport edge (Bun's
 * built-in WebSocket, so no dependency) and stays a few lines, like
 * `connectCdpSocket` in cdp-client.ts.
 *
 * Logging records connects, close codes, counts and durations only. The socket
 * URL carries a one-time ticket and events carry message text, so neither is
 * ever logged.
 */

import { getLogger } from '@logtape/logtape';
import { InvalidInputError } from './cli-errors.ts';
import { classifyError } from './command-errors.ts';
import { normalizeIdentifier } from './slack-url-parser.ts';
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

/**
 * Parse `--channels`: comma-separated channel or DM IDs, or Slack links to
 * them. Undefined or blank means no filter. Duplicates collapse.
 */
export function parseChannelFilter(value?: string): Set<string> | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new InvalidInputError('--channels needs at least one channel ID.');
  return new Set(parts.map((part) => normalizeIdentifier(part, 'channel', '--channels')));
}

const ATTACHMENT_KEYS =['pretext', 'title', 'text', 'fallback', 'author_name'] as const;

/**
 * Turn a raw RTM event into a `message` line, or null when it is not one we
 * emit: not a message, missing channel or ts, a hidden event (Slack's own
 * bookkeeping), or outside the `channels` filter when one is given.
 */
export function toListenEvent(raw: any, channels?: ReadonlySet<string>): ListenEvent | null {
  if (!raw || typeof raw !== 'object' || raw.type !== 'message' || raw.hidden) return null;
  if (typeof raw.channel !== 'string' || typeof raw.ts !== 'string') return null;
  if (channels && channels.size > 0 && !channels.has(raw.channel)) return null;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const files = Array.isArray(raw.files) ? raw.files : [];
  return {
    type: 'message',
    channel: raw.channel,
    ts: raw.ts,
    thread_ts: raw.thread_ts,
    user: raw.user,
    username: raw.username ?? raw.bot_profile?.name,
    bot_id: raw.bot_id,
    subtype: raw.subtype,
    text: typeof raw.text === 'string' ? raw.text : '',
    attachments: attachments.map((a: any) =>
      Object.fromEntries(ATTACHMENT_KEYS.filter((k) => a?.[k] !== undefined).map((k) => [k, a[k]]))),
    files: files.map((f: any) => ({ id: f?.id, name: f?.name, filetype: f?.filetype })),
  };
}

/**
 * Errors that reconnecting cannot fix: a dead session, a token Slack does not
 * allow on RTM, or any other answer Slack gave with a code that is not
 * retryable. A failure with no Slack answer (network, socket handshake, a
 * malformed rtm.connect reply) is not fatal and is retried. Classified by type
 * through `classifyError`, never by message.
 */
export function isFatalListenError(err: unknown): boolean {
  const classified = classifyError(err);
  if (classified.retryable) return false;
  return classified.code !== 'unknown' || classified.slack_error !== undefined;
}

export interface ListenerOptions {
  /** Open a fresh socket: rtm.connect, then the WebSocket handshake. */
  connect: () => Promise<RtmSocket>;
  /** Receives every output line, in order. */
  emit: (event: ListenEvent) => void;
  channels?: ReadonlySet<string>;
  /** Stops the listener: closes the socket and resolves. */
  signal?: AbortSignal;
  pingIntervalMs?: number;
  /** No frame at all for this long means the connection is dead. */
  idleTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const PING_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
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

/**
 * Run one socket until it closes. Resolves with whether Slack said `hello`,
 * which is what decides if the next reconnect starts from the minimum backoff.
 */
function runSocket(socket: RtmSocket, options: ListenerOptions): Promise<boolean> {
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let gotHello = false;
    let lastFrameAt = Date.now();
    let pingId = 0;
    let closed = false;
    let emitted = 0;

    const closeSocket = () => {
      try {
        socket.close();
      } catch {
        // already gone
      }
    };
    const onAbort = () => closeSocket();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setInterval(() => {
      if (Date.now() - lastFrameAt > idleTimeoutMs) {
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

    socket.onMessage((data) => {
      lastFrameAt = Date.now();
      let raw: any;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      if (raw?.type === 'hello') {
        gotHello = true;
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

    socket.onClose((code) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
      logger.info('RTM socket closed, code {code}, {count} messages emitted', { code, count: emitted });
      resolve(gotHello);
    });
  });
}

/**
 * Listen until `signal` aborts. Reconnects after every close; the wait doubles
 * on consecutive failures (from minBackoffMs up to maxBackoffMs) and goes back
 * to the minimum once a socket reaches `hello`. A fatal error
 * (`isFatalListenError`) is rethrown instead of retried.
 */
export async function runListener(options: ListenerOptions): Promise<void> {
  const minBackoff = options.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  const sleep = options.sleep ?? abortableSleep;
  let backoff = minBackoff;

  while (!options.signal?.aborted) {
    let healthy = false;
    try {
      const startedAt = Date.now();
      const socket = await options.connect();
      logger.debug('RTM socket opened in {duration_ms} ms', { duration_ms: Date.now() - startedAt });
      healthy = await runSocket(socket, options);
    } catch (err) {
      if (isFatalListenError(err)) throw err;
      logger.warn('RTM connect failed: {error}', { error: errorMessageForLog(err) });
    }
    if (options.signal?.aborted) break;
    backoff = healthy ? minBackoff : Math.min(backoff * 2, maxBackoff);
    await sleep(healthy ? minBackoff : backoff, options.signal);
  }
}

/**
 * Open the RTM WebSocket. The transport edge — it needs a live Slack, so it
 * stays thin and every decision lives in `runListener`.
 */
export function connectRtmSocket(
  session: { url: string; headers: Record<string, string> },
  timeoutMs = 15_000,
): Promise<RtmSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Bun's WebSocket takes handshake headers as a second-argument option.
    const ws = new WebSocket(session.url, { headers: session.headers } as any);
    let closeHandler: ((code: number) => void) | undefined;
    let closeCode: number | undefined;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // nothing to release
      }
      reject(new Error(`RTM socket did not open within ${timeoutMs}ms`));
    }, timeoutMs);

    ws.onclose = (ev) => {
      closeCode = ev.code;
      closeHandler?.(ev.code);
    };

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (handler) => {
          ws.onmessage = (ev) => handler(String(ev.data));
        },
        onClose: (handler) => {
          closeHandler = handler;
          if (closeCode !== undefined) handler(closeCode);
        },
      });
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Could not open the RTM socket'));
    };
  });
}
