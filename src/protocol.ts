import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;

export const EXIT_CODES = {
  success: 0,
  internal: 1,
  invalidInput: 2,
  configuration: 3,
  unsupported: 4,
  external: 5,
  timeout: 6,
  resource: 7,
  confirmation: 8,
} as const;

export type RetrySafety = "safe" | "unsafe" | "never";

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
    this.retrySafety = options.retrySafety ?? "never";
    this.exitCode = options.exitCode ?? exitCodeFor(code);
  }
}

const exitCodeFor = (code: string): number => {
  if (code.startsWith("invalid_") || code.startsWith("request_")) {
    return EXIT_CODES.invalidInput;
  }
  if (code.includes("timeout")) return EXIT_CODES.timeout;
  if (code.startsWith("configuration_")) return EXIT_CODES.configuration;
  if (code.includes("not_found") || code.includes("missing")) {
    return EXIT_CODES.resource;
  }
  if (code.includes("failed") || code.startsWith("discord_")) {
    return EXIT_CODES.external;
  }
  return EXIT_CODES.internal;
};

const snowflakeSchema = z
  .string()
  .regex(/^\d{15,22}$/, "Expected a Discord ID");
export const voiceChannelIDsSchema = z
  .array(snowflakeSchema)
  .min(1, "At least one voice channel ID is required")
  .refine(
    (values) => new Set(values).size === values.length,
    "Voice channel IDs must be unique",
  );
const executablePathSchema = z
  .string()
  .min(1)
  .refine(path.isAbsolute, "Hook path must be absolute");
const nullableExecutablePathSchema = executablePathSchema.nullable();

export const initRequestSchema = z
  .object({
    discordToken: z.string().trim().min(1),
    voiceChannelIDs: voiceChannelIDsSchema,
    emptyGraceMs: z.number().int().min(0).max(3_600_000).optional(),
    hookTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    transcriptionHook: executablePathSchema.optional(),
    hooks: z
      .object({
        channelJoined: executablePathSchema.optional(),
        channelLeft: executablePathSchema.optional(),
        recordingStarted: executablePathSchema.optional(),
        recordingCompleted: executablePathSchema.optional(),
        recordingFailed: executablePathSchema.optional(),
        transcriptionCompleted: executablePathSchema.optional(),
        transcriptionFailed: executablePathSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type InitRequest = z.infer<typeof initRequestSchema>;

export const configUpdateRequestSchema = z
  .object({
    discordToken: z.string().trim().min(1).optional(),
    voiceChannelIDs: voiceChannelIDsSchema.optional(),
    emptyGraceMs: z.number().int().min(0).max(3_600_000).optional(),
    hookTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    transcriptionHook: nullableExecutablePathSchema.optional(),
    hooks: z
      .object({
        channelJoined: nullableExecutablePathSchema.optional(),
        channelLeft: nullableExecutablePathSchema.optional(),
        recordingStarted: nullableExecutablePathSchema.optional(),
        recordingCompleted: nullableExecutablePathSchema.optional(),
        recordingFailed: nullableExecutablePathSchema.optional(),
        transcriptionCompleted: nullableExecutablePathSchema.optional(),
        transcriptionFailed: nullableExecutablePathSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, {
    message: "At least one configuration value is required",
  });

export type ConfigUpdateRequest = z.infer<typeof configUpdateRequestSchema>;

const retrySafetySchema = z.enum(["safe", "unsafe", "never"]);
const commandDefinitionSchema = z.object({
  command: z.string(),
  description: z.string(),
  mutation: z.boolean(),
  requestSchema: z.string().nullable(),
  resultSchema: z.string(),
});
const helpResultSchema = z.object({
  scope: z.array(z.string()),
  commands: z.array(z.string()),
  definitions: z.array(commandDefinitionSchema),
  globalOptions: z.array(z.string()),
});
const doctorCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
const doctorResultSchema = z.object({
  checks: z.array(doctorCheckSchema),
  passed: z.boolean(),
  contracts: z.object({
    schemaVersion: z.number().int(),
    names: z.array(z.string()),
    selected: z
      .object({ name: z.string(), schema: z.record(z.string(), z.unknown()) })
      .nullable(),
  }),
});
const configurationSchema = z.object({
  discordToken: z.literal("[redacted]"),
  voiceChannelIDs: z.array(snowflakeSchema),
  emptyGraceMs: z.number().int(),
  hookTimeoutMs: z.number().int(),
  transcriptionHook: z.string().nullable(),
  hooks: z.record(z.string(), z.string()),
});
const configurationUpdateResultSchema = z.object({
  changed: z.boolean(),
  dryRun: z.boolean(),
  restartRequired: z.boolean(),
  configuration: configurationSchema,
});
const recordingSummarySchema = z.object({
  recordingID: z.string(),
  guildID: z.string(),
  guildName: z.string().nullable(),
  channelID: z.string(),
  channelName: z.string().nullable(),
  status: z.string(),
  storage: z.enum(["inProgress", "published"]),
  directory: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  interrupted: z.boolean(),
  audioFile: z.string().nullable(),
  audioFileBytes: z.number().int(),
  transcriptionStatus: z.string().nullable(),
  transcriptJSONBytes: z.number().int(),
  transcriptTextBytes: z.number().int(),
  participantCount: z.number().int(),
  pcmFileCount: z.number().int(),
  pcmFileBytes: z.number().int(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
});
const recordingTotalsSchema = z.object({
  recordingCount: z.number().int(),
  audioFileBytes: z.number().int(),
  pcmFileCount: z.number().int(),
  pcmFileBytes: z.number().int(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
});
const recordingsListResultSchema = z.object({
  recordings: z.array(recordingSummarySchema),
  totals: recordingTotalsSchema,
});
const recordingVerifyResultSchema = z.object({
  recordingID: z.string(),
  passed: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["pass", "warn", "fail"]),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  files: z.array(
    z.object({
      relativePath: z.string(),
      bytes: z.number().int(),
      sha256: z.string(),
    }),
  ),
});
const recordingExportResultSchema = z.union([
  z.object({
    changed: z.literal(false),
    dryRun: z.literal(true),
    recordingID: z.string(),
    destination: z.string(),
    files: z.array(z.string()),
  }),
  z.object({
    changed: z.literal(true),
    dryRun: z.literal(false),
    recordingID: z.string(),
    destination: z.string(),
    fileCount: z.number().int(),
    sourceBytes: z.number().int(),
    wavFile: z.string().nullable(),
    checksumsFile: z.string(),
  }),
]);
const runtimeStatusResultSchema = z.object({
  daemon: z.object({
    running: z.boolean(),
    pid: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    uptimeMs: z.number().nullable(),
  }),
  configuration: z.object({
    voiceChannelIDs: z.array(snowflakeSchema),
    emptyGraceMs: z.number().int(),
    transcriptionEnabled: z.boolean(),
  }),
  recording: z.record(z.string(), z.unknown()).nullable(),
  latestRecording: recordingSummarySchema.nullable(),
  storage: recordingTotalsSchema,
});
const startupStatusSchema = z.object({
  label: z.string(),
  plistPath: z.string(),
  configured: z.boolean(),
  loaded: z.boolean(),
  running: z.boolean(),
  state: z.string().nullable(),
  pid: z.number().int().nullable(),
  lastExitStatus: z.number().int().nullable(),
});
const startupInstallResultSchema = z.union([
  z.object({
    dryRun: z.literal(true),
    label: z.string(),
    plistPath: z.string(),
    plist: z.string(),
  }),
  z.object({ dryRun: z.literal(false), status: startupStatusSchema }),
]);
const startupWrappedStatusResultSchema = z.object({
  status: startupStatusSchema,
});
const startupLogsResultSchema = z.object({
  files: z.array(
    z.object({ path: z.string(), lines: z.array(z.string()) }),
  ),
});
const initResultSchema = z.object({
  created: z.boolean(),
  home: z.string(),
  configurationPath: z.string(),
  dryRun: z.boolean(),
  discordToken: z.literal("[redacted]"),
  voiceChannelIDs: z.array(snowflakeSchema),
});
const envelopeSuccessSchema = z.object({
  command: z.string(),
  ok: z.boolean(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestID: z.string(),
  result: z.unknown(),
});
const envelopeErrorSchema = z.object({
  command: z.string(),
  error: z.object({
    code: z.string(),
    details: z.record(z.string(), z.unknown()),
    message: z.string(),
    retrySafety: retrySafetySchema,
  }),
  ok: z.literal(false),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestID: z.string(),
});

const resultAnySchema = z.unknown();
const versionResultSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  schemaVersion: z.literal(SCHEMA_VERSION),
  version: z.string(),
});

export const schemas = {
  "config.update.request": configUpdateRequestSchema,
  "config.update.result": configurationUpdateResultSchema,
  "configuration.result": configurationSchema,
  "doctor.result": doctorResultSchema,
  "envelope.error": envelopeErrorSchema,
  "envelope.success": envelopeSuccessSchema,
  "help.result": helpResultSchema,
  "init.request": initRequestSchema,
  "init.result": initResultSchema,
  "recording.export.result": recordingExportResultSchema,
  "recording.summary": recordingSummarySchema,
  "recording.verify.result": recordingVerifyResultSchema,
  "recordings.list.result": recordingsListResultSchema,
  "result.any": resultAnySchema,
  "startup.install.result": startupInstallResultSchema,
  "startup.logs.result": startupLogsResultSchema,
  "startup.status.result": startupStatusSchema,
  "startup.wrappedStatus.result": startupWrappedStatusResultSchema,
  "status.result": runtimeStatusResultSchema,
  "version.result": versionResultSchema,
} as const;

export type SchemaName = keyof typeof schemas;

export const schemaNames = (): SchemaName[] =>
  (Object.keys(schemas) as SchemaName[]).sort();

export const getSchema = (name: string): Record<string, unknown> => {
  const schema = schemas[name as SchemaName];
  if (!schema) {
    throw new GuildscribeError("invalid_schema", "Unknown schema name", {
      details: { name, available: schemaNames() },
      exitCode: EXIT_CODES.invalidInput,
    });
  }
  return canonicalize(z.toJSONSchema(schema)) as Record<string, unknown>;
};

export const schemaCatalog = (): Record<string, Record<string, unknown>> =>
  Object.fromEntries(schemaNames().map((name) => [name, getSchema(name)]));

export const validateResult = (name: SchemaName, result: unknown): unknown => {
  const parsed = schemas[name].safeParse(result);
  if (!parsed.success) {
    throw new GuildscribeError(
      "internal_result_contract_violation",
      "Command result did not match its published schema",
      {
        details: {
          schema: name,
          issues: parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.join("."),
          })),
        },
        retrySafety: "unsafe",
      },
    );
  }
  return result;
};

export const packageVersion = (): string => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new GuildscribeError(
      "internal_package_version_missing",
      "package.json does not contain a version",
      { retrySafety: "unsafe" },
    );
  }
  return parsed.version;
};

export interface ResultContext {
  command: string;
  pretty: boolean;
  requestID: string;
}

export const createRequestID = (requested?: string): string =>
  requested?.trim() || randomUUID();

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const writeEnvelope = (context: ResultContext, envelope: unknown): void => {
  process.stdout.write(
    `${JSON.stringify(canonicalize(envelope), null, context.pretty ? 2 : undefined)}\n`,
  );
};

export const writeSuccess = (
  context: ResultContext,
  result: unknown,
  ok = true,
): void => {
  writeEnvelope(context, {
    command: context.command,
    ok,
    protocolVersion: PROTOCOL_VERSION,
    requestID: context.requestID,
    result,
  });
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
          { retrySafety: "unsafe", cause: error },
        );
  writeEnvelope(context, {
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
  });
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
  const match = /^(\d+)(ms|s|m)$/.exec(value.trim());
  if (!match) {
    throw new GuildscribeError(
      "invalid_timeout",
      "Timeout must be a positive integer followed by ms, s, or m",
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

type DiagnosticVerbosity = "quiet" | "normal" | "verbose" | "debug";

let diagnosticFile: DiagnosticFileConfiguration | null = null;
let diagnosticVerbosity: DiagnosticVerbosity = "normal";

export const configureDiagnostics = (verbosity: DiagnosticVerbosity): void => {
  diagnosticVerbosity = verbosity;
};

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
    if (existsSync(source)) {
      renameSync(source, `${configuration.path}.${index + 1}`);
    }
  }
  renameSync(configuration.path, `${configuration.path}.1`);
};

const shouldWriteDiagnostic = (
  level: "debug" | "error" | "info" | "warn",
): boolean => {
  if (level === "error") return true;
  if (diagnosticVerbosity === "quiet") return false;
  if (level === "debug") {
    return (
      diagnosticVerbosity === "verbose" || diagnosticVerbosity === "debug"
    );
  }
  return true;
};

export const diagnostic = (
  level: "debug" | "error" | "info" | "warn",
  event: string,
  details: Record<string, unknown> = {},
): void => {
  if (!shouldWriteDiagnostic(level)) return;
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
