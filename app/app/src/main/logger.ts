/**
 * Structured rotating logger for MyPilot.
 *
 * Log locations (AGB_LOG_DIR overrides):
 *   ~/Library/Application Support/MyPilot/logs/app.log
 *   ~/Library/Application Support/MyPilot/logs/browser.log
 *   ~/Library/Application Support/MyPilot/logs/renderer.log
 *   ~/Library/Application Support/MyPilot/logs/engine.log
 *
 * Rotation: 10 MB per file, keep 5 rotated files.
 * Format: { ts, level, channel, msg, ...extra }
 *
 * Track H owns this file. Track A/B/C/D will import channel loggers.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactString, redactValue } from './logRedaction';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[Logger]';
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB
const MAX_ROTATED_FILES = 5;
const LOG_DIR_NAME = 'logs';
const RESERVED_LOG_FIELDS = new Set(['ts', 'level', 'channel', 'msg']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  channel: string;
  msg: string;
  [key: string]: unknown;
}

export function sanitizeLogChannel(channel: string): string {
  const safe = channel
    .trim()
    .replace(/[\0/\\]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');

  return safe || 'log';
}

export function sanitizeLogExtra(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    // Everything written to disk goes through redaction first, so no call site
    // can accidentally persist a token, a one-time code, or a signed URL.
    const redacted = redactValue(key, value);
    if (RESERVED_LOG_FIELDS.has(key)) {
      safe[`extra_${key}`] = redacted;
    } else {
      safe[key] = redacted;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// RotatingFileWriter
// ---------------------------------------------------------------------------

/**
 * Simple synchronous rotating file writer.
 * Rotates when current file exceeds maxBytes.
 * Keeps at most maxFiles rotated copies (.1 … .N).
 */
export class RotatingFileWriter {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(filePath: string, maxBytes = MAX_FILE_BYTES, maxFiles = MAX_ROTATED_FILES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(line: string): void {
    const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');

    let currentSize = 0;
    try {
      const stat = fs.statSync(this.filePath);
      currentSize = stat.size;
    } catch {
      // File doesn't exist yet — that's fine, size = 0
    }

    if (currentSize + lineBytes > this.maxBytes) {
      this._rotate();
    }

    // Fire-and-forget async write — never block the event loop.
    // Lines are queued by the caller; a dropped line under extreme load
    // is preferable to janking the main process.
    fs.appendFile(this.filePath, line + '\n', 'utf-8', (err) => {
      if (err) {
        process.stderr.write(
          `${LOG_PREFIX} Failed to write log line: ${(err as Error).message}\n`,
        );
      }
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  private _rotate(): void {
    // Shift existing rotated files: .5 → deleted, .4 → .5, … .1 → .2
    for (let i = this.maxFiles; i >= 1; i--) {
      const dst = `${this.filePath}.${i}`;
      const actual = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      try {
        if (fs.existsSync(actual)) {
          fs.renameSync(actual, dst);
        }
      } catch (err) {
        process.stderr.write(`${LOG_PREFIX} Rotation error: ${(err as Error).message}\n`);
      }
    }
    // After rotation the primary file no longer exists; appendFile will create it
  }
}

// ---------------------------------------------------------------------------
// ChannelLogger
// ---------------------------------------------------------------------------

/**
 * A logger bound to a specific channel (e.g. "main", "daemon", "agent-task-abc").
 * All methods accept an optional extra-fields object for structured metadata.
 */
export class ChannelLogger {
  private readonly channel: string;
  private readonly writer: RotatingFileWriter;
  private readonly minLevel: LogLevel;

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(channel: string, writer: RotatingFileWriter, minLevel: LogLevel = 'info') {
    this.channel = channel;
    this.writer = writer;
    this.minLevel = minLevel;
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this._log('debug', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this._log('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this._log('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this._log('error', msg, extra);
  }

  getFilePath(): string {
    return this.writer.getFilePath();
  }

  private _log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (
      ChannelLogger.LEVEL_ORDER[level] <
      ChannelLogger.LEVEL_ORDER[this.minLevel]
    ) {
      return;
    }

    const safeExtra = sanitizeLogExtra(extra);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      channel: this.channel,
      // Error messages routinely embed the offending value (a URL with a code,
      // a rejected token), so the message is redacted too.
      msg: redactString(msg),
      ...safeExtra,
    };

    const line = JSON.stringify(entry);
    this.writer.write(line);

    // Mirror to console for visibility during development. Uses the redacted
    // payload so credentials never reach a terminal scrollback either.
    const consoleFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.log;
    consoleFn(`[${level.toUpperCase()}][${this.channel}] ${redactString(msg)}`, safeExtra ?? '');
  }
}

// ---------------------------------------------------------------------------
// LoggerFactory
// ---------------------------------------------------------------------------

/**
 * Creates and caches channel loggers.
 * Ensures logs directory exists.
 */
export class LoggerFactory {
  private readonly logsDir: string;
  private readonly cache = new Map<string, ChannelLogger>();

  constructor(userDataPath?: string) {
    const base =
      userDataPath ??
      (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { app } = require('electron');
          return app.getPath('userData');
        } catch {
          return path.join(os.tmpdir(), 'MyPilot');
        }
      })();

    this.logsDir = path.join(base, LOG_DIR_NAME);
    fs.mkdirSync(this.logsDir, { recursive: true });
    console.log(`${LOG_PREFIX} Logs directory: ${this.logsDir}`);
  }

  /**
   * Get or create a channel logger.
   * Channel names are sanitized before mapping to filenames:
   *   'app'           → app.log
   *   'daemon'        → daemon.log
   */
  getLogger(channel: string, minLevel?: LogLevel): ChannelLogger {
    const safeChannel = sanitizeLogChannel(channel);
    const cached = this.cache.get(safeChannel);
    if (cached) return cached;

    const filename = `${safeChannel}.log`;
    const filePath = path.join(this.logsDir, filename);
    const writer = new RotatingFileWriter(filePath);
    const logger = new ChannelLogger(safeChannel, writer, minLevel);

    this.cache.set(safeChannel, logger);
    console.log(`${LOG_PREFIX} Created channel logger: ${safeChannel} → ${filePath}`);
    return logger;
  }

  getLogsDir(): string {
    return this.logsDir;
  }
}

// ---------------------------------------------------------------------------
// Singleton exports
// ---------------------------------------------------------------------------

export const loggerFactory = new LoggerFactory();
export const mainLogger = loggerFactory.getLogger('app');
export const browserLogger = loggerFactory.getLogger('browser');
export const rendererLogger = loggerFactory.getLogger('renderer');
export const engineLogger = loggerFactory.getLogger('engine');
