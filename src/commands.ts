import { GuildscribeError, type SchemaName } from "./protocol.js";

export interface CommandDefinition {
  key: string;
  path: string;
  description: string;
  mutation: boolean;
  requestSchema: SchemaName | null;
  resultSchema: SchemaName;
}

const definitions = [
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

export const GLOBAL_OPTIONS = [
  "--home <absolute-path>",
  "--request-id <ID>",
  "--timeout <duration>",
  "--no-input",
  "--non-interactive",
  "--quiet",
  "--verbose",
  "--verbosity <quiet|normal|verbose|debug>",
] as const;

export const commandCatalog = (): CommandDefinition[] =>
  definitions.map((definition) => ({ ...definition }));

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
  const matching = definitions.filter((definition) => {
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
    })),
    globalOptions: [...GLOBAL_OPTIONS],
  };
};
