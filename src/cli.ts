import { Command, CommanderError, Option } from "commander";

import {
  getCommandDefinition,
  helpResult,
  leafUsage,
} from "./commands.js";
import {
  getPaths,
  initializeHome,
  loadConfig,
  readConfigUpdateRequest,
  readInitRequest,
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
  pretty?: boolean;
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
  pretty: Boolean(options.pretty),
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
  ) => Promise<{ result: unknown; ok?: boolean }>,
): Promise<void> => {
  const definition = getCommandDefinition(commandKey);
  const context = contextFor(commandKey, options);
  try {
    applyRuntimeControls(options);
    const timeoutMs = parseDurationMs(options.timeout ?? "30s");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new GuildscribeError(
            "command_timeout",
            "Command exceeded its configured timeout",
            {
              details: { timeoutMs },
              retrySafety: definition.mutation ? "unsafe" : "safe",
            },
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
    const outcome = await Promise.race([operation(context), timeout]).finally(
      () => {
        if (timer) clearTimeout(timer);
      },
    );
    validateResult(definition.resultSchema, outcome.result);
    writeSuccess(context, outcome.result, outcome.ok ?? true);
    if (outcome.ok === false) process.exitCode = 1;
  } catch (error) {
    process.exitCode = writeFailure(context, error);
  }
};

const fallbackOptions = (argv: string[]): GlobalOptions => {
  const requestIndex = argv.indexOf("--request-id");
  const options: GlobalOptions = { pretty: argv.includes("--pretty") };
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
    "--pretty",
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
    return [
      ...argv.slice(0, 2),
      ...globalDiscoveryArguments(args),
      "version",
    ];
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

export const runCLI = async (inputArgv = process.argv): Promise<void> => {
  const argv = normalizeDiscovery(inputArgv);
  const program = new Command();
  program
    .name("guildscribe")
    .description("Record Discord voice meetings into local audio artifacts")
    .helpOption(false)
    .option("-V, --version", "print the version as JSON")
    .option("--home <absolute-path>", "runtime home")
    .option("--request-id <ID>", "caller-supplied request ID")
    .option("--pretty", "pretty-print JSON")
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
    .requiredOption("--request <file-or-dash>", "JSON request file or - for stdin")
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
    .requiredOption("--request <file-or-dash>", "JSON request file or - for stdin")
    .option("--dry-run", "validate and preview without writing")
    .action(
      async (options: { request: string; dryRun?: boolean }, command) => {
        const globals = globalsFor(command);
        await runFinite("config update", globals, async () => ({
          result: await updateConfiguration(
            getPaths(resolveHome(globals.home)),
            await readConfigUpdateRequest(options.request),
            Boolean(options.dryRun),
          ),
        }));
      },
    );

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
