import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

export const PROTOCOL_VERSION = 1;

export type RetrySafety = "safe" | "unsafe" | "unknown";

export class GuildscribeError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown>;
  public readonly retrySafety: RetrySafety;
  public readonly exitCode: number;

  public constructor(
    code: string,
    message: string,
    options: {
      details?: Record<string, unknown>;
      retrySafety?: RetrySafety;
      exitCode?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GuildscribeError";
    this.code = code;
    this.details = options.details ?? {};
    this.retrySafety = options.retrySafety ?? "safe";
    this.exitCode = options.exitCode ?? 1;
  }
}

export interface ResultContext {
  command: string;
  pretty: boolean;
  requestID: string;
}

export const createRequestID = (requested?: string): string =>
  requested?.trim() || randomUUID();

export const writeSuccess = (
  context: ResultContext,
  result: unknown,
  ok = true,
): void => {
  const envelope = {
    command: context.command,
    ok,
    protocolVersion: PROTOCOL_VERSION,
    requestID: context.requestID,
    result,
  };
  process.stdout.write(
    `${JSON.stringify(envelope, null, context.pretty ? 2 : undefined)}\n`,
  );
};

export const writeFailure = (
  context: ResultContext,
  error: unknown,
): number => {
  const failure =
    error instanceof GuildscribeError
      ? error
      : new GuildscribeError(
          "internal_error",
          error instanceof Error ? error.message : "Unknown internal error",
          { retrySafety: "unknown", cause: error },
        );
  const envelope = {
    command: context.command,
    error: {
      code: failure.code,
      details: failure.details,
      message: failure.message,
      retrySafety: failure.retrySafety,
    },
    ok: false,
    protocolVersion: PROTOCOL_VERSION,
    requestID: context.requestID,
  };
  process.stdout.write(
    `${JSON.stringify(envelope, null, context.pretty ? 2 : undefined)}\n`,
  );
  return failure.exitCode;
};

export const sanitizeError = (
  error: unknown,
  secrets: string[] = [],
): string => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 2_000);
};

export const parseDurationMs = (value: string): number => {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) {
    throw new GuildscribeError(
      "invalid_timeout",
      "Timeout must be a non-negative integer followed by ms, s, or m",
    );
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new GuildscribeError("invalid_timeout", "Timeout must be positive");
  }
  return duration;
};

interface DiagnosticFileOptions {
  maxBytes?: number;
  retainedFiles?: number;
}

interface DiagnosticFileConfiguration {
  path: string;
  maxBytes: number;
  retainedFiles: number;
}

let diagnosticFile: DiagnosticFileConfiguration | null = null;

export const configureDiagnosticFile = (
  filePath: string,
  options: DiagnosticFileOptions = {},
): void => {
  diagnosticFile = {
    path: filePath,
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
    retainedFiles: options.retainedFiles ?? 3,
  };
};

const rotateDiagnosticFile = (
  configuration: DiagnosticFileConfiguration,
): void => {
  if (!existsSync(configuration.path)) return;
  if (statSync(configuration.path).size < configuration.maxBytes) return;

  const oldest = `${configuration.path}.${configuration.retainedFiles}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = configuration.retainedFiles - 1; index >= 1; index -= 1) {
    const source = `${configuration.path}.${index}`;
    if (existsSync(source))
      renameSync(source, `${configuration.path}.${index + 1}`);
  }
  renameSync(configuration.path, `${configuration.path}.1`);
};

export const diagnostic = (
  level: "debug" | "error" | "info" | "warn",
  event: string,
  details: Record<string, unknown> = {},
): void => {
  const line = `${JSON.stringify({ event, level, time: new Date().toISOString(), ...details })}\n`;
  if (diagnosticFile) {
    try {
      rotateDiagnosticFile(diagnosticFile);
      appendFileSync(diagnosticFile.path, line, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          event: "diagnostic.fileWriteFailed",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          time: new Date().toISOString(),
        })}\n`,
      );
    }
  }
  if (!diagnosticFile || process.stderr.isTTY) process.stderr.write(line);
};
