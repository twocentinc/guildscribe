import { Command, CommanderError, Option } from "commander";

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
import {
  exportRecording,
  verifyRecording,
} from "./recordingArtifacts.js";
import {
  createRequestID,
  GuildscribeError,
  parseDurationMs,
  type ResultContext,
  writeFailure,
  writeSuccess,
} from "./results.js";
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

const VERSION = "0.3.0";

interface GlobalOptions {
  home?: string;
  nonInteractive?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  requestId?: string;
  timeout?: string;
  verbose?: boolean;
  verbosity?: "quiet" | "normal" | "verbose" | "debug";
  version?: boolean;
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

const runFinite = async (
  command: string,
  options: GlobalOptions,
  operation: (
    context: ResultContext,
  ) => Promise<{ result: unknown; ok?: boolean }>,
): Promise<void> => {
  const context = contextFor(command, options);
  try {
    const outcome = await operation(context);
    writeSuccess(context, outcome.result, outcome.ok ?? true);
    if (outcome.ok === false) process.exitCode = 1;
  } catch (error) {
    process.exitCode = writeFailure(context, error);
  }
};

const fallbackOptions = (argv: string[]): GlobalOptions => {
  const requestIndex = argv.indexOf("--request-id");
  const options: GlobalOptions = {
    pretty: argv.includes("--pretty"),
  };
  const requestID = requestIndex >= 0 ? argv[requestIndex + 1] : undefined;
  if (requestID) options.requestId = requestID;
  return options;
};

export const runCLI = async (argv = process.argv): Promise<void> => {
  const program = new Command();
  program
    .name("guildscribe")
    .description("Record Discord voice meetings into local audio artifacts")
    .helpOption("-h, --help")
    .option("-V, --version", "print the version as JSON")
    .option("--home <absolute-path>", "runtime home", undefined)
    .option("--request-id <ID>", "caller-supplied request ID")
    .option("--pretty", "pretty-print JSON")
    .option("--timeout <duration>", "finite operation timeout", "30s")
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
    .showHelpAfterError()
    .exitOverride();

  program.action(async (_options, command) => {
    const globals = globalsFor(command);
    if (globals.version) {
      await runFinite("version", globals, async () => ({
        result: { version: VERSION },
      }));
      return;
    }
    command.help();
  });

  program
    .command("version")
    .description("print version and protocol information")
    .action(async (_options, command) => {
      await runFinite("version", globalsFor(command), async () => ({
        result: { protocolVersion: 1, version: VERSION },
      }));
    });

  program
    .command("init")
    .description("create a new Guildscribe runtime home")
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
            voiceChannelIDs: request.voiceChannelIDs,
          },
        };
      });
    });

  program
    .command("doctor")
    .description("validate local tools, configuration, and Discord access")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("doctor", globals, async () => {
        const home = resolveHome(globals.home);
        const timeoutMs = parseDurationMs(globals.timeout ?? "30s");
        const result = await runDoctor(getPaths(home), timeoutMs);
        return { result, ok: result.passed };
      });
    });

  program
    .command("status")
    .description("show daemon, recording, and storage status")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("status", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await getRuntimeStatus(paths) };
      });
    });

  const configuration = program
    .command("config")
    .description("inspect or update configuration");

  configuration
    .command("show")
    .description("show configuration with the Discord token redacted")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("config show", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: redactedConfiguration(await loadConfig(paths)) };
      });
    });

  configuration
    .command("update")
    .description("atomically update configuration")
    .requiredOption(
      "--request <file-or-dash>",
      "JSON request file or - for stdin",
    )
    .option("--dry-run", "validate and preview without writing")
    .action(
      async (options: { request: string; dryRun?: boolean }, command) => {
        const globals = globalsFor(command);
        await runFinite("config update", globals, async () => {
          const paths = getPaths(resolveHome(globals.home));
          const request = await readConfigUpdateRequest(options.request);
          return {
            result: await updateConfiguration(
              paths,
              request,
              Boolean(options.dryRun),
            ),
          };
        });
      },
    );

  const recordings = program
    .command("recordings")
    .description("inspect captured recordings");

  recordings
    .command("list")
    .description("list published and in-progress recordings")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("recordings list", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await listRecordings(paths) };
      });
    });

  recordings
    .command("show <recordingID>")
    .description("show one recording and its artifact sizes")
    .action(async (recordingID: string, _options, command) => {
      const globals = globalsFor(command);
      await runFinite("recordings show", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await showRecording(paths, recordingID) };
      });
    });

  recordings
    .command("verify <recordingID>")
    .description("validate recording artifacts and calculate checksums")
    .action(async (recordingID: string, _options, command) => {
      const globals = globalsFor(command);
      await runFinite("recordings verify", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        const result = await verifyRecording(paths, recordingID);
        return { result, ok: result.passed };
      });
    });

  recordings
    .command("export <recordingID>")
    .description("copy a recording into a portable checksummed directory")
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
        await runFinite("recordings export", globals, async () => {
          const paths = getPaths(resolveHome(globals.home));
          return {
            result: await exportRecording(
              paths,
              recordingID,
              options.destination,
              {
                dryRun: Boolean(options.dryRun),
                wav: Boolean(options.wav),
                timeoutMs: parseDurationMs(globals.timeout ?? "30s"),
              },
            ),
          };
        });
      },
    );

  const daemon = program
    .command("daemon")
    .description("manage the background recorder");
  daemon
    .command("run")
    .description("run the recorder in the foreground")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      const context = contextFor("daemon run", globals);
      try {
        const home = resolveHome(globals.home);
        const paths = getPaths(home);
        const config = await loadConfig(paths);
        await runDaemon(paths, config);
      } catch (error) {
        process.exitCode = writeFailure(context, error);
      }
    });

  const startup = program
    .command("startup")
    .description("manage the macOS LaunchAgent");

  startup
    .command("install")
    .description("install and load the per-user macOS LaunchAgent")
    .option("--dry-run", "render the LaunchAgent without installing it")
    .action(async (options: { dryRun?: boolean }, command) => {
      const globals = globalsFor(command);
      await runFinite("startup install", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        if (options.dryRun) {
          return { result: { dryRun: true, ...planStartupInstall(paths) } };
        }
        return {
          result: { dryRun: false, status: await installStartup(paths) },
        };
      });
    });

  startup
    .command("uninstall")
    .description("unload the LaunchAgent and remove its plist")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("startup uninstall", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: { status: await uninstallStartup(paths) } };
      });
    });

  startup
    .command("status")
    .description("show the LaunchAgent's installed and running state")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("startup status", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await getStartupStatus(paths) };
      });
    });

  startup
    .command("start")
    .description("start an installed LaunchAgent")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("startup start", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await startStartup(paths) };
      });
    });

  startup
    .command("stop")
    .description("gracefully stop the LaunchAgent until it is started again")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("startup stop", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await stopStartup(paths) };
      });
    });

  startup
    .command("restart")
    .description("gracefully stop and start the LaunchAgent")
    .action(async (_options, command) => {
      const globals = globalsFor(command);
      await runFinite("startup restart", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await restartStartup(paths) };
      });
    });

  startup
    .command("logs")
    .description("read recent daemon and LaunchAgent logs")
    .option("--lines <count>", "lines to return from each log", "100")
    .action(async (options: { lines: string }, command) => {
      const globals = globalsFor(command);
      await runFinite("startup logs", globals, async () => {
        const paths = getPaths(resolveHome(globals.home));
        return { result: await readStartupLogs(paths, Number(options.lines)) };
      });
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return;
      }
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
