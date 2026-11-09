import {
  sendMessage,
  syncCommands,
  discoverCapabilities,
} from "./discordActions.js";
import { messageSendRequestSchema, discordIDSchema } from "./protocol.js";
import {
  getMessage,
  listHistory,
  getTranscript,
  exportTranscript,
  retryTranscript,
  databaseStatus,
  verifyDatabase,
  backupDatabase,
  type HistoryOptions,
} from "./history.js";
import { Command, CommanderError, Option } from "commander";

import {
  getPaths,
  initializeHome,
  loadConfig,
  readConfigUpdateRequest,
  readInitRequest,
  readRequest,
  redactedConfiguration,
  resolveHome,
  updateConfiguration,
} from "./config.js";
import { runDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { listRecordings, showRecording } from "./recording.js";
import { exportRecording, verifyRecording } from "./recordingArtifacts.js";
import {
  configureDiagnostics,
  createRequestID,
  GuildscribeError,
  packageVersion,
  parseDurationMs,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  transcriptRetryRequestSchema,
  type ResultContext,
  validateResult,
  writeFailure,
  writeSuccess,
} from "./protocol.js";
import {
  getStartupStatus,
  installStartup,
  planStartupInstall,
  readStartupLogs,
  restartStartup,
  startStartup,
  stopStartup,
  uninstallStartup,
} from "./startup.js";
import { getRuntimeStatus } from "./status.js";

interface GlobalOptions {
  home?: string;
  input?: boolean;
  nonInteractive?: boolean;
  quiet?: boolean;
  requestId?: string;
  timeout?: string;
  verbose?: boolean;
  verbosity?: "quiet" | "normal" | "verbose" | "debug";
}

const contextFor = (
  command: string,
  options: GlobalOptions,
): ResultContext => ({
  command,
  requestID: createRequestID(options.requestId),
});

const globalsFor = (command: Command): GlobalOptions =>
  command.optsWithGlobals<GlobalOptions>();

const applyRuntimeControls = (options: GlobalOptions): void => {
  if (options.quiet && (options.verbose || options.verbosity)) {
    throw new GuildscribeError(
      "invalid_verbosity",
      "--quiet cannot be combined with --verbose or --verbosity",
    );
  }
  if (options.verbose && options.verbosity) {
    throw new GuildscribeError(
      "invalid_verbosity",
      "--verbose cannot be combined with --verbosity",
    );
  }
  configureDiagnostics(
    options.quiet
      ? "quiet"
      : options.verbose
        ? "verbose"
        : (options.verbosity ?? "normal"),
  );
};

const runFinite = async (
  commandKey: string,
  options: GlobalOptions,
  operation: (
    context: ResultContext,
    signal: AbortSignal,
  ) => Promise<{ result: unknown; ok?: boolean }>,
): Promise<void> => {
  const definition = getCommandDefinition(commandKey);
  const context = contextFor(commandKey, options);
  try {
    applyRuntimeControls(options);
    const timeoutMs = parseDurationMs(options.timeout ?? "30s");
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new GuildscribeError(
            "command_timeout",
            "Command exceeded its configured timeout",
            {
              details: {
                timeoutMs,
                operation: commandKey,
                outcomeUnknown: definition.mutation,
              },
              retrySafety: definition.mutation ? "unsafe" : "safe",
            },
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
    const outcome = await Promise.race([
      operation(context, controller.signal),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    validateResult(definition.resultSchema, outcome.result);
    writeSuccess(context, outcome.result, outcome.ok ?? true);
    if (outcome.ok === false) process.exitCode = 1;
  } catch (error) {
    process.exitCode = writeFailure(context, error);
  }
};

const fallbackOptions = (argv: string[]): GlobalOptions => {
  const requestIndex = argv.indexOf("--request-id");
  const options: GlobalOptions = {};
  const requestID = requestIndex >= 0 ? argv[requestIndex + 1] : undefined;
  if (requestID) options.requestId = requestID;
  return options;
};

const leaf = (parent: Command, key: string): Command => {
  const definition = getCommandDefinition(key);
  return parent.command(leafUsage(key)).description(definition.description);
};

const globalDiscoveryArguments = (args: string[]): string[] => {
  const valueOptions = new Set([
    "--home",
    "--request-id",
    "--timeout",
    "--verbosity",
  ]);
  const booleanOptions = new Set([
    "--no-input",
    "--non-interactive",
    "--quiet",
    "--verbose",
  ]);
  const globals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (valueOptions.has(argument)) {
      globals.push(argument);
      const value = args[index + 1];
      if (value !== undefined) {
        globals.push(value);
        index += 1;
      }
    } else if (
      booleanOptions.has(argument) ||
      [...valueOptions].some((option) => argument.startsWith(`${option}=`))
    ) {
      globals.push(argument);
    }
  }
  return globals;
};

const normalizeDiscovery = (argv: string[]): string[] => {
  const args = argv.slice(2);
  if (args.includes("-V") || args.includes("--version")) {
    return [...argv.slice(0, 2), ...globalDiscoveryArguments(args), "version"];
  }
  const helpIndex = args.findIndex(
    (argument) => argument === "-h" || argument === "--help",
  );
  if (helpIndex < 0) return argv;
  const valueOptions = new Set([
    "--home",
    "--request-id",
    "--timeout",
    "--verbosity",
  ]);
  const positionals: string[] = [];
  for (let index = 0; index < helpIndex; index += 1) {
    const argument = args[index] as string;
    if (valueOptions.has(argument)) {
      index += 1;
    } else if (!argument.startsWith("-")) {
      positionals.push(argument);
    }
  }
  const scope: string[] = [];
  for (const positional of positionals) {
    try {
      helpResult([...scope, positional]);
      scope.push(positional);
    } catch {
      break;
    }
  }
  return [
    ...argv.slice(0, 2),
    ...globalDiscoveryArguments(args),
    "help",
    ...scope,
  ];
};

export const createProgram = (): Command => {
  const program = new Command();
  program
    .name("guildscribe")
    .description("Record Discord voice meetings into local audio artifacts")
    .helpOption(false)
    .option("-V, --version", "print the version as JSON")
    .option("--home <absolute-path>", "runtime home")
    .option("--request-id <ID>", "caller-supplied request ID")
    .option("--timeout <duration>", "finite operation timeout", "30s")
    .option("--no-input", "disable interactive behavior")
    .option("--non-interactive", "disable interactive behavior")
    .option("--quiet", "suppress non-error diagnostics")
    .option("--verbose", "enable verbose diagnostics")
    .addOption(
      new Option("--verbosity <level>", "diagnostic verbosity").choices([
        "quiet",
        "normal",
        "verbose",
        "debug",
      ]),
    )
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .exitOverride();

  program.action(async (_options, command) => {
    await runFinite("help", globalsFor(command), async () => ({
      result: helpResult([]),
    }));
  });

  leaf(program, "help").action(async (scope: string[], _options, command) => {
    await runFinite("help", globalsFor(command), async () => ({
      result: helpResult(scope),
    }));
  });

  leaf(program, "version").action(async (_options, command) => {
    await runFinite("version", globalsFor(command), async () => ({
      result: {
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        version: packageVersion(),
      },
    }));
  });

  leaf(program, "init")
    .requiredOption(
      "--request <file-or-dash>",
      "JSON request file or - for stdin",
    )
    .option("--dry-run", "validate without writing")
    .action(async (options: { request: string; dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("init", globals, async () => {
        const request = await readInitRequest(options.request);
        const home = resolveHome(globals.home);
        const result = await initializeHome(
          getPaths(home),
          request,
          Boolean(options.dryRun),
        );
        return {
          result: {
            ...result,
            dryRun: Boolean(options.dryRun),
            discordToken: "[redacted]",
            ownerUserID: request.ownerUserID ?? null,
            messageChannelIDs: request.messageChannelIDs ?? [],
            voiceChannelIDs: request.voiceChannelIDs,
          },
        };
      });
    });

  leaf(program, "doctor")
    .option("--schema <name>", "include one published JSON schema")
    .action(async (options: { schema?: string }, command) => {
      const globals = globalsFor(command);
      await runFinite("doctor", globals, async () => {
        const result = await runDoctor(
          getPaths(resolveHome(globals.home)),
          parseDurationMs(globals.timeout ?? "30s"),
          options.schema,
        );
        return { result, ok: result.passed };
      });
    });

  leaf(program, "status").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("status", globals, async () => ({
      result: await getRuntimeStatus(getPaths(resolveHome(globals.home))),
    }));
  });

  const configuration = program
    .command("config")
    .description("inspect or update configuration")
    .action(async (_options, command) => {
      await runFinite("help", globalsFor(command), async () => ({
        result: helpResult(["config"]),
      }));
    });

  leaf(configuration, "config show").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("config show", globals, async () => ({
      result: redactedConfiguration(
        await loadConfig(getPaths(resolveHome(globals.home))),
      ),
    }));
  });

  leaf(configuration, "config update")
    .requiredOption(
      "--request <file-or-dash>",
      "JSON request file or - for stdin",
    )
    .option("--dry-run", "validate and preview without writing")
    .action(async (options: { request: string; dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("config update", globals, async () => ({
        result: await updateConfiguration(
          getPaths(resolveHome(globals.home)),
          await readConfigUpdateRequest(options.request),
          Boolean(options.dryRun),
        ),
      }));
    });

  const recordings = program
    .command("recordings")
    .description("inspect captured recordings")
    .action(async (_options, command) => {
      await runFinite("help", globalsFor(command), async () => ({
        result: helpResult(["recordings"]),
      }));
    });

  leaf(recordings, "recordings list").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("recordings list", globals, async () => ({
      result: await listRecordings(getPaths(resolveHome(globals.home))),
    }));
  });

  leaf(recordings, "recordings show").action(
    async (recordingID: string, _options, command) => {
      const globals = globalsFor(command);
      await runFinite("recordings show", globals, async () => ({
        result: await showRecording(
          getPaths(resolveHome(globals.home)),
          recordingID,
        ),
      }));
    },
  );

  leaf(recordings, "recordings verify").action(
    async (recordingID: string, _options, command) => {
      const globals = globalsFor(command);
      await runFinite("recordings verify", globals, async () => {
        const result = await verifyRecording(
          getPaths(resolveHome(globals.home)),
          recordingID,
        );
        return { result, ok: result.passed };
      });
    },
  );

  leaf(recordings, "recordings export")
    .requiredOption("--destination <absolute-path>", "new export directory")
    .option("--wav", "also render a PCM WAV copy with FFmpeg")
    .option("--dry-run", "show the export plan without writing")
    .action(
      async (
        recordingID: string,
        options: { destination: string; dryRun?: boolean; wav?: boolean },
        command,
      ) => {
        const globals = globalsFor(command);
        await runFinite("recordings export", globals, async () => ({
          result: await exportRecording(
            getPaths(resolveHome(globals.home)),
            recordingID,
            options.destination,
            {
              dryRun: Boolean(options.dryRun),
              wav: Boolean(options.wav),
              timeoutMs: parseDurationMs(globals.timeout ?? "30s"),
            },
          ),
        }));
      },
    );

  const group = (name: string, description: string) =>
    program
      .command(name)
      .description(description)
      .action(async (_options, command) => {
        await runFinite("help", globalsFor(command), async () => ({
          result: helpResult([name]),
        }));
      });
  const historyOptions = (command: Command) =>
    command
      .option("--channel <ID>", "channel ID")
      .option("--after <timestamp>", "inclusive ISO timestamp")
      .option("--before <timestamp>", "exclusive ISO timestamp")
      .option("--limit <count>", "page size from 1 to 200", "50")
      .option("--cursor <cursor>", "next page cursor");
  const messages = group(
    "messages",
    "browse and search local Discord messages",
  );
  leaf(messages, "messages send")
    .requiredOption("--request <file-or-dash>", "JSON request file or stdin")
    .option("--dry-run", "validate without sending")
    .action(async (options: { request: string; dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("messages send", globals, async (_context, signal) => ({
        result: await sendMessage(
          await loadConfig(getPaths(resolveHome(globals.home))),
          await readRequest(options.request, messageSendRequestSchema),
          !!options.dryRun,
          signal,
        ),
      }));
    });
  const commands = group("commands", "manage Discord slash commands");
  leaf(commands, "commands sync")
    .option("--dry-run", "preview registration")
    .action(async (options: { dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("commands sync", globals, async (_context, signal) => ({
        result: await syncCommands(
          await loadConfig(getPaths(resolveHome(globals.home))),
          !!options.dryRun,
          signal,
        ),
      }));
    });
  leaf(program, "capabilities")
    .option("--live", "check Discord without mutations")
    .option("--channel <ID>", "channel permission scope")
    .action(async (options: { live?: boolean; channel?: string }, command) => {
      const globals = globalsFor(command);
      await runFinite("capabilities", globals, async (_context, signal) => ({
        result: await discoverCapabilities(
          await loadConfig(getPaths(resolveHome(globals.home))),
          !!options.live,
          options.channel === undefined
            ? undefined
            : discordIDSchema.parse(options.channel),
          signal,
        ),
      }));
    });
  historyOptions(leaf(messages, "messages list"))
    .option("--author <ID>", "author ID")
    .option(
      "--include-threads",
      "include child threads of the selected channel",
    )
    .action(async (options: HistoryOptions, command) => {
      const globals = globalsFor(command);
      await runFinite("messages list", globals, async () => ({
        result: await listHistory(
          getPaths(resolveHome(globals.home)),
          "messages",
          options,
        ),
      }));
    });
  leaf(messages, "messages get").action(
    async (id: string, _options, command) => {
      const globals = globalsFor(command);
      await runFinite("messages get", globals, async () => ({
        result: await getMessage(getPaths(resolveHome(globals.home)), id),
      }));
    },
  );
  historyOptions(leaf(messages, "messages search"))
    .option("--author <ID>", "author ID")
    .option(
      "--include-threads",
      "include child threads of the selected channel",
    )
    .action(async (query: string, options: HistoryOptions, command) => {
      const globals = globalsFor(command);
      await runFinite("messages search", globals, async () => ({
        result: await listHistory(
          getPaths(resolveHome(globals.home)),
          "messages",
          options,
          query,
        ),
      }));
    });
  const transcript = group(
    "transcript",
    "read, search, export, or retry transcription",
  );
  leaf(transcript, "transcript get")
    .option("--include-segments", "include a page of transcript segments")
    .option("--limit <count>", "segment page size from 1 to 200", "50")
    .option("--cursor <cursor>", "next segment page")
    .action(async (id: string, options: HistoryOptions, command) => {
      const globals = globalsFor(command);
      await runFinite("transcript get", globals, async () => ({
        result: await getTranscript(
          getPaths(resolveHome(globals.home)),
          id,
          options,
        ),
      }));
    });
  historyOptions(leaf(transcript, "transcript search"))
    .option("--speaker <ID>", "speaker Discord user ID")
    .action(async (query: string, options: HistoryOptions, command) => {
      const globals = globalsFor(command);
      await runFinite("transcript search", globals, async () => ({
        result: await listHistory(
          getPaths(resolveHome(globals.home)),
          "transcript",
          options,
          query,
        ),
      }));
    });
  leaf(transcript, "transcript export")
    .requiredOption("--destination <absolute-path>", "new export file")
    .addOption(
      new Option("--format <format>", "export format")
        .choices(["txt", "json", "srt", "vtt"])
        .default("txt"),
    )
    .option("--dry-run", "preview without writing")
    .action(
      async (
        id: string,
        options: { destination: string; format: string; dryRun?: boolean },
        command,
      ) => {
        const globals = globalsFor(command);
        await runFinite("transcript export", globals, async () => ({
          result: await exportTranscript(
            getPaths(resolveHome(globals.home)),
            id,
            options.destination,
            options.format,
            Boolean(options.dryRun),
          ),
        }));
      },
    );
  leaf(transcript, "transcript retry")
    .requiredOption("--request <file-or-dash>", "JSON request file or stdin")
    .option("--dry-run", "preview without queuing")
    .action(async (options: { request: string; dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("transcript retry", globals, async () => {
        const request = await readRequest(
          options.request,
          transcriptRetryRequestSchema,
        );
        return {
          result: await retryTranscript(
            getPaths(resolveHome(globals.home)),
            request.recordingID,
            Boolean(options.dryRun),
          ),
        };
      });
    });
  const database = group(
    "database",
    "inspect and back up local SQLite storage",
  );
  leaf(database, "database status").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("database status", globals, async () => ({
      result: await databaseStatus(getPaths(resolveHome(globals.home))),
    }));
  });
  leaf(database, "database verify").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("database verify", globals, async () => {
      const result = await verifyDatabase(getPaths(resolveHome(globals.home)));
      return { result, ok: result.passed };
    });
  });
  leaf(database, "database backup")
    .requiredOption("--destination <absolute-path>", "new SQLite backup file")
    .option("--dry-run", "preview without writing")
    .action(
      async (options: { destination: string; dryRun?: boolean }, command) => {
        const globals = globalsFor(command);
        await runFinite("database backup", globals, async () => ({
          result: await backupDatabase(
            getPaths(resolveHome(globals.home)),
            options.destination,
            Boolean(options.dryRun),
          ),
        }));
      },
    );

  const daemon = program
    .command("daemon")
    .description("manage the background recorder")
    .action(async (_options, command) => {
      await runFinite("help", globalsFor(command), async () => ({
        result: helpResult(["daemon"]),
      }));
    });

  leaf(daemon, "daemon run").action(async (_options, command) => {
    const globals = globalsFor(command);
    const context = contextFor("daemon run", globals);
    try {
      applyRuntimeControls(globals);
      const paths = getPaths(resolveHome(globals.home));
      await runDaemon(paths, await loadConfig(paths));
    } catch (error) {
      process.exitCode = writeFailure(context, error);
    }
  });

  const startup = program
    .command("startup")
    .description("manage the macOS LaunchAgent")
    .action(async (_options, command) => {
      await runFinite("help", globalsFor(command), async () => ({
        result: helpResult(["startup"]),
      }));
    });

  leaf(startup, "startup install")
    .option("--dry-run", "render the LaunchAgent without installing it")
    .action(async (options: { dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("startup install", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return options.dryRun
          ? { result: { dryRun: true, ...planStartupInstall(paths) } }
          : { result: { dryRun: false, status: await installStartup(paths) } };
      });
    });

  leaf(startup, "startup uninstall").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("startup uninstall", globals, async () => ({
      result: {
        status: await uninstallStartup(getPaths(resolveHome(globals.home))),
      },
    }));
  });

  leaf(startup, "startup status").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("startup status", globals, async () => ({
      result: await getStartupStatus(getPaths(resolveHome(globals.home))),
    }));
  });

  leaf(startup, "startup start").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("startup start", globals, async () => ({
      result: await startStartup(getPaths(resolveHome(globals.home))),
    }));
  });

  leaf(startup, "startup stop").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("startup stop", globals, async () => ({
      result: await stopStartup(getPaths(resolveHome(globals.home))),
    }));
  });

  leaf(startup, "startup restart").action(async (_options, command) => {
    const globals = globalsFor(command);
    await runFinite("startup restart", globals, async () => ({
      result: await restartStartup(getPaths(resolveHome(globals.home))),
    }));
  });

  leaf(startup, "startup logs")
    .option("--lines <count>", "lines to return from each log", "100")
    .action(async (options: { lines: string }, command) => {
      const globals = globalsFor(command);
      await runFinite("startup logs", globals, async () => ({
        result: await readStartupLogs(
          getPaths(resolveHome(globals.home)),
          Number(options.lines),
        ),
      }));
    });

  return program;
};

export const runCLI = async (inputArgv = process.argv): Promise<void> => {
  const argv = normalizeDiscovery(inputArgv);
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      const context = contextFor("cli", fallbackOptions(argv));
      process.exitCode = writeFailure(
        context,
        new GuildscribeError("invalid_command", error.message, {
          details: { commanderCode: error.code },
        }),
      );
      return;
    }
    throw error;
  }
};

import type { SchemaName } from "./protocol.js";

export interface CommandDefinition {
  key: string;
  path: string;
  description: string;
  mutation: boolean;
  requestSchema: SchemaName | null;
  resultSchema: SchemaName;
  options?: {
    flags: string;
    description: string;
    required: boolean;
    defaultValue: unknown;
    choices: string[] | null;
  }[];
}

const definitions = [
  {
    key: "capabilities",
    path: "capabilities",
    description:
      "inspect local readiness and optional live Discord permissions",
    mutation: false,
    requestSchema: null,
    resultSchema: "capabilities.result",
  },
  {
    key: "messages send",
    path: "messages send",
    description: "send text or embeds to a Discord channel",
    mutation: true,
    requestSchema: "messages.send.request",
    resultSchema: "messages.send.result",
  },
  {
    key: "commands sync",
    path: "commands sync",
    description: "register configured guild slash commands",
    mutation: true,
    requestSchema: null,
    resultSchema: "commands.sync.result",
  },
  {
    key: "messages list",
    path: "messages list",
    description: "browse stored messages",
    mutation: false,
    requestSchema: null,
    resultSchema: "messages.page.result",
  },
  {
    key: "messages get",
    path: "messages get <messageID>",
    description: "read one stored message",
    mutation: false,
    requestSchema: null,
    resultSchema: "messages.get.result",
  },
  {
    key: "messages search",
    path: "messages search <query>",
    description: "search message text",
    mutation: false,
    requestSchema: null,
    resultSchema: "messages.page.result",
  },
  {
    key: "transcript get",
    path: "transcript get <recordingID>",
    description: "read transcript metadata and optional segments",
    mutation: false,
    requestSchema: null,
    resultSchema: "transcript.get.result",
  },
  {
    key: "transcript search",
    path: "transcript search <query>",
    description: "search spoken text",
    mutation: false,
    requestSchema: null,
    resultSchema: "transcript.search.result",
  },
  {
    key: "transcript export",
    path: "transcript export <recordingID>",
    description: "export transcript text, JSON, or subtitles",
    mutation: true,
    requestSchema: null,
    resultSchema: "transcript.export.result",
  },
  {
    key: "transcript retry",
    path: "transcript retry",
    description: "queue an explicit retry of failed transcription",
    mutation: true,
    requestSchema: "transcript.retry.request",
    resultSchema: "transcript.retry.result",
  },
  {
    key: "database status",
    path: "database status",
    description: "show database version, size, and counts",
    mutation: false,
    requestSchema: null,
    resultSchema: "database.status.result",
  },
  {
    key: "database verify",
    path: "database verify",
    description: "check database and search index integrity",
    mutation: false,
    requestSchema: null,
    resultSchema: "database.verify.result",
  },
  {
    key: "database backup",
    path: "database backup",
    description: "create a consistent database backup",
    mutation: true,
    requestSchema: null,
    resultSchema: "database.backup.result",
  },
  {
    key: "help",
    path: "help [scope...]",
    description: "list commands and their machine-readable contracts",
    mutation: false,
    requestSchema: null,
    resultSchema: "help.result",
  },
  {
    key: "version",
    path: "version",
    description: "print version and protocol information",
    mutation: false,
    requestSchema: null,
    resultSchema: "version.result",
  },
  {
    key: "init",
    path: "init",
    description: "create a new Guildscribe runtime home",
    mutation: true,
    requestSchema: "init.request",
    resultSchema: "init.result",
  },
  {
    key: "doctor",
    path: "doctor",
    description: "validate local tools, configuration, Discord, and contracts",
    mutation: false,
    requestSchema: null,
    resultSchema: "doctor.result",
  },
  {
    key: "status",
    path: "status",
    description: "show daemon, recording, and storage status",
    mutation: false,
    requestSchema: null,
    resultSchema: "status.result",
  },
  {
    key: "config show",
    path: "config show",
    description: "show configuration with the Discord token redacted",
    mutation: false,
    requestSchema: null,
    resultSchema: "configuration.result",
  },
  {
    key: "config update",
    path: "config update",
    description: "atomically update configuration",
    mutation: true,
    requestSchema: "config.update.request",
    resultSchema: "config.update.result",
  },
  {
    key: "recordings list",
    path: "recordings list",
    description: "list published and in-progress recordings",
    mutation: false,
    requestSchema: null,
    resultSchema: "recordings.list.result",
  },
  {
    key: "recordings show",
    path: "recordings show <recordingID>",
    description: "show one recording and its artifact sizes",
    mutation: false,
    requestSchema: null,
    resultSchema: "recording.summary",
  },
  {
    key: "recordings verify",
    path: "recordings verify <recordingID>",
    description: "validate recording artifacts and calculate checksums",
    mutation: false,
    requestSchema: null,
    resultSchema: "recording.verify.result",
  },
  {
    key: "recordings export",
    path: "recordings export <recordingID>",
    description: "copy a recording into a portable checksummed directory",
    mutation: true,
    requestSchema: null,
    resultSchema: "recording.export.result",
  },
  {
    key: "daemon run",
    path: "daemon run",
    description: "run the recorder in the foreground",
    mutation: true,
    requestSchema: null,
    resultSchema: "result.any",
  },
  {
    key: "startup install",
    path: "startup install",
    description: "install and load the per-user macOS LaunchAgent",
    mutation: true,
    requestSchema: null,
    resultSchema: "startup.install.result",
  },
  {
    key: "startup uninstall",
    path: "startup uninstall",
    description: "unload the LaunchAgent and remove its plist",
    mutation: true,
    requestSchema: null,
    resultSchema: "startup.wrappedStatus.result",
  },
  {
    key: "startup status",
    path: "startup status",
    description: "show the LaunchAgent's installed and running state",
    mutation: false,
    requestSchema: null,
    resultSchema: "startup.status.result",
  },
  {
    key: "startup start",
    path: "startup start",
    description: "start an installed LaunchAgent",
    mutation: true,
    requestSchema: null,
    resultSchema: "startup.status.result",
  },
  {
    key: "startup stop",
    path: "startup stop",
    description: "gracefully stop the LaunchAgent until it is started again",
    mutation: true,
    requestSchema: null,
    resultSchema: "startup.status.result",
  },
  {
    key: "startup restart",
    path: "startup restart",
    description: "gracefully stop and start the LaunchAgent",
    mutation: true,
    requestSchema: null,
    resultSchema: "startup.status.result",
  },
  {
    key: "startup logs",
    path: "startup logs",
    description: "read recent daemon and LaunchAgent logs",
    mutation: false,
    requestSchema: null,
    resultSchema: "startup.logs.result",
  },
] as const satisfies readonly CommandDefinition[];

const optionCatalog = (command: Command) =>
  command.options.map((o) => ({
    flags: o.flags,
    description: o.description,
    required: o.mandatory,
    defaultValue: o.defaultValue ?? null,
    choices: o.argChoices ?? null,
  }));
export const globalOptions = () => createProgram().options.map((o) => o.flags);
export const commandCatalog = (): CommandDefinition[] => {
  const program = createProgram();
  return definitions.map((definition) => {
    let command = program;
    for (const part of definition.key.split(" ")) {
      const child = command.commands.find((c) => c.name() === part);
      if (!child) throw new Error(`Missing runtime command ${definition.key}`);
      command = child;
    }
    return { ...definition, options: optionCatalog(command) };
  });
};

export const getCommandDefinition = (key: string): CommandDefinition => {
  const definition = definitions.find((candidate) => candidate.key === key);
  if (!definition) {
    throw new GuildscribeError("internal_command_missing", "Unknown command", {
      details: { key },
      retrySafety: "unsafe",
    });
  }
  return { ...definition };
};

export const leafUsage = (key: string): string => {
  const definition = getCommandDefinition(key);
  const parent = key.split(" ").slice(0, -1);
  return definition.path.split(" ").slice(parent.length).join(" ");
};

const literalPath = (path: string): string[] =>
  path
    .split(" ")
    .filter((token) => !token.startsWith("<") && !token.startsWith("["));

export const helpResult = (scope: string[]) => {
  const matching = commandCatalog().filter((definition) => {
    const literal = literalPath(definition.path);
    return scope.every((token, index) => literal[index] === token);
  });
  if (matching.length === 0) {
    throw new GuildscribeError("invalid_help_scope", "Unknown help scope", {
      details: { scope },
    });
  }
  return {
    scope,
    commands: matching.map((definition) => `guildscribe ${definition.path}`),
    definitions: matching.map((definition) => ({
      command: definition.key,
      description: definition.description,
      mutation: definition.mutation,
      requestSchema: definition.requestSchema,
      resultSchema: definition.resultSchema,
      options: definition.options,
    })),
    globalOptions: globalOptions(),
  };
};

export const GLOBAL_OPTIONS = globalOptions();
