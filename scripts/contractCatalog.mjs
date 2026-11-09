import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { commandCatalog, GLOBAL_OPTIONS } from "../dist/commands.js";
import {
  schemaCatalog,
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
} from "../dist/protocol.js";
import {
  participantDocumentSchema,
  recordingIntervalSchema,
} from "../dist/recording.js";
import {
  transcriptResultSchema,
  legacyStorageBackupSchema,
} from "../dist/transcription.js";
import { transcriptExportSchema, cursorSchema } from "../dist/history.js";
import { daemonLockSchema, daemonRuntimeStateSchema } from "../dist/status.js";
import { databaseCall, databasePathFor } from "../dist/storage.js";

export const cliContract = () => ({
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: SCHEMA_VERSION,
  commands: commandCatalog(),
  globalOptions: [...GLOBAL_OPTIONS],
  schemas: schemaCatalog(),
});

// Reference the validators used by real readers/writers, never copied schemas.
// contractVersion is also used for out-of-band formats (hook responses/cursors).
export const documentDefinitions = {
  participants: { contractVersion: 1, schema: participantDocumentSchema },
  interval: { contractVersion: 1, schema: recordingIntervalSchema },
  transcriptionResult: { contractVersion: 1, schema: transcriptResultSchema },
  transcriptExport: { contractVersion: 1, schema: transcriptExportSchema },
  daemonLock: { contractVersion: 1, schema: daemonLockSchema },
  daemonRuntime: { contractVersion: 1, schema: daemonRuntimeStateSchema },
  historyCursor: { contractVersion: 1, schema: cursorSchema },
  legacyStorageBackup: {
    contractVersion: 1,
    schema: legacyStorageBackupSchema,
  },
};
export const documentContracts = () =>
  Object.fromEntries(
    Object.entries(documentDefinitions).map(
      ([name, { contractVersion, schema }]) => [
        name,
        { contractVersion, schema: z.toJSONSchema(schema) },
      ],
    ),
  );

export const sqliteContract = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-contract-"));
  try {
    const database = databasePathFor(home);
    const [version, objects] = await databaseCall(
      database,
      [
        { sql: "PRAGMA user_version", mode: "get" },
        // FTS implementation/shadow tables and SQLite-owned automatic indexes are
        // excluded. Their public parent DDL contains all authored constraints.
        {
          sql: "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
          mode: "all",
        },
      ],
      true,
    );
    const publicObjects = objects.filter(
      (o) =>
        !/^messages_fts_|^transcript_segments_fts_/.test(o.name) ||
        o.type === "trigger",
    );
    return {
      schemaVersion: version.user_version,
      objects: publicObjects.map((o) => ({
        ...o,
        sql: o.sql.trim().replace(/\s+/g, " "),
      })),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

export const assertUnchangedVersion = (previous, next, label) => {
  if (JSON.stringify(previous) !== JSON.stringify(next))
    throw new Error(
      `${label} is frozen. Review the change and advance its contract version; do not overwrite the existing version snapshot.`,
    );
};
