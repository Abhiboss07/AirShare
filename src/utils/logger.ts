/**
 * Structured logger.
 *
 * Purpose: every log line carries time, severity, module and message (plus
 * optional structured fields). No bare `console.log` anywhere else in the code.
 *
 * Public API: `createLogger(module, level)` -> `Logger`. `logger.child(sub)`
 * derives a scoped logger that prefixes the module path.
 */

import type { LogLevel } from "../config/types.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(subModule: string): Logger;
  readonly module: string;
}

/** Sink abstraction so tests can capture output instead of writing to stdout. */
export interface LogSink {
  write(line: string): void;
}

const consoleSink: LogSink = {
  write(line: string): void {
    process.stdout.write(line + "\n");
  },
};

function serializeFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      parts.push(`${key}=${value.name}: ${value.message}`);
    } else if (typeof value === "object") {
      parts.push(`${key}=${safeJson(value)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return " " + parts.join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

class LoggerImpl implements Logger {
  constructor(
    public readonly module: string,
    private readonly minWeight: number,
    private readonly sink: LogSink,
  ) {}

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.minWeight) return;
    const ts = new Date().toISOString();
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${this.module}] ${message}${serializeFields(fields)}`;
    this.sink.write(line);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }
  child(subModule: string): Logger {
    return new LoggerImpl(`${this.module}:${subModule}`, this.minWeight, this.sink);
  }
}

export function createLogger(
  module: string,
  level: LogLevel = "info",
  sink: LogSink = consoleSink,
): Logger {
  return new LoggerImpl(module, LEVEL_WEIGHT[level], sink);
}
