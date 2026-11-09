# Guildscribe specification

Status: implementation contract for SQLite message/recording storage, recorder
operations, optional executable-hook transcription, and standalone distribution.

## Product definition

Guildscribe is a self-hosted Discord bot that records meetings from a configured
voice-channel allowlist. It joins and records only one channel at a time.
Discord supplies speaker identity, Guildscribe keeps speaker-separated capture
intervals, and FFmpeg publishes a combined MP3.

An optional dedicated transcription hook runs over completed participant audio.
The owner may point it at a Nightcrew adapter or any other executable.
Guildscribe does not bundle an adapter, summarize, extract bullets, run
reasoning prompts, manage models, or run its own inference server.

## Current scope

The implemented slice:

- reads one Discord bot token and one or more voice channel IDs from an
  owner-only `.env`;
- joins when a human enters an allowed channel and no other recording is
  active;
- records only one allowed channel at a time;
- records each Discord speaker as independent PCM intervals;
- waits 30 seconds after the last human leaves, cancelling the wait when a
  human returns;
- renders and validates one combined MP3;
- preserves interrupted recordings and recovers their captured audio after a
  restart;
- records versioned participant presence history on the recording timeline;
- exposes redacted configuration, live status, artifact verification, and
  portable checksummed exports through agent-safe JSON commands;
- invokes optional local executable hooks for recording events; and
- durably queues one optional transcription executable at a time, validates its
  pending result, and publishes canonical transcript files; and
- packages as an npm CLI and provides macOS startup, upgrade, and uninstall
  workflows that preserve runtime data.

Bundled Nightcrew integration, speaker-track publication, transcript merging,
and reasoning stages are not implemented.

The next approved transcription slice replaces the synchronous pending-result
file with asynchronous adapter callbacks. It is specified below under
"Planned asynchronous transcription callbacks" but is not part of the current
runtime or command catalog yet.

## Non-goals

- Meeting bullets, summaries, action items, or reasoning output.
- User-defined stages or arbitrary processing pipelines.
- Model installation, downloading, or server management.
- Installing FFmpeg, Nightcrew, llama.cpp, or model weights.
- A web dashboard.
- A remote database or SQL execution service.
- General-purpose audio-file import.

## Supported platforms and prerequisites

Guildscribe targets macOS and Linux and requires Node.js 22.12 or newer. The
implemented service manager targets macOS LaunchAgents; Linux service
management is deliberately deferred until it can be tested.

The host must already provide:

- `ffmpeg`;
- `ffprobe`.

Guildscribe verifies these executables but does not install them. Recording is
fully functional without Nightcrew or Granite.

## Repository structure

The source stays intentionally flat until a concern develops several cohesive
modules:

```text
guildscribe/
  AGENTS.md
  README.md
  LICENSE
  package.json
  package-lock.json
  tsconfig.json
  docs/
    spec.md
  scripts/
    daemon
    installLaunchAgent.sh
    packageRelease.mjs
    testPackage.mjs
    updateContractSnapshots.mjs
    uninstallGlobal.sh
    uninstallLaunchAgent.sh
    upgradeGlobal.sh
  src/
    index.ts
    cli.ts
    commands.ts
    config.ts
    daemon.ts
    doctor.ts
    hooks.ts
    macosLaunchAgent.ts
    recording.ts
    recordingArtifacts.ts
    renderer.ts
    protocol.ts
    startup.ts
    status.ts
    transcription.ts
  test/
    config.test.mjs
    contracts.test.mjs
    macosLaunchAgent.test.mjs
    manifests.test.mjs
    operationsCli.test.mjs
    participants.test.mjs
    recordingArtifacts.test.mjs
    recorder.test.mjs
    recordings.test.mjs
    protocol.test.mjs
    status.test.mjs
    transcription.test.mjs
    snapshots/
      command-catalog.json
      schemas.json
```

`src/recording.ts` is the single recording-domain owner. It contains recording
and interval formats, atomic storage, participant presence, inventory,
recovery, and live Discord capture orchestration. `src/renderer.ts` remains the
audio engine, while `src/recordingArtifacts.ts` owns offline verification and
portable export. This keeps the complete recording lifecycle readable in one
place without mixing FFmpeg or export mechanics into it.

`src/commands.ts` is the runtime source of truth for public commands,
descriptions, mutation classification, and request/result schema associations.
`src/protocol.ts` owns request schemas, JSON envelopes, retry safety, exit
classes, diagnostics, schema export, and package-version discovery. Reviewed
snapshots freeze the public catalog and schemas. `guildscribe help [scope...]`
and `guildscribe doctor --schema <name>` expose the same contracts as JSON.

## Runtime home

The default runtime home is `~/.guildscribe`. `--home <absolute-path>` selects
another home for every command.

```text
~/.guildscribe/
  .env
  guildscribe.sqlite
  guildscribe.lock
  runtime.json
  logs/
    daemon.jsonl
    daemon.jsonl.1
    launchd.stdout.log
    launchd.stderr.log
  in-progress/
    <recordingID>/
      participants.json
      intervals/
        <intervalID>.json
        <intervalID>.pcm
      audio.part.mp3
  recordings/
    <year>/
      <month>/
        <recordingID>/
          participants.json
          intervals/
            <intervalID>.json
            <intervalID>.pcm
          audio.mp3
```

`guildscribe.lock` exists only while the daemon is running and contains a
versioned JSON record with its process ID and start time. `runtime.json` is an
owner-only atomic heartbeat containing daemon phase, Discord readiness, update
time, and the last sanitized runtime error. The daemon refreshes it every 10
seconds; a live lock with no matching heartbeat within 30 seconds is stale.
Completed raw PCM
files and their JSON interval sidecars remain permanently with the published
recording so speaker audio, identity, timing, and capture gaps stay inspectable
and available to optional processing.

The runtime home uses mode `0700` and `.env` uses mode `0600` on POSIX systems.
Guildscribe rejects a runtime home or configuration file that is a symbolic
link, is owned by another user, has group/world permissions, or is not the
expected filesystem type. Runtime files never belong in the source checkout.

`daemon.jsonl` is the structured operational log. Guildscribe rotates it at 10
MB and retains three prior files. The launchd stdout and stderr files capture
wrapper failures and unhandled output before structured logging is available.

## Configuration

`.env` is authoritative for configuration. Guildscribe recognizes:

```text
GUILDSCRIBE_DISCORD_TOKEN
GUILDSCRIBE_OWNER_USER_ID
GUILDSCRIBE_VOICE_CHANNEL_IDS
GUILDSCRIBE_MESSAGE_CHANNEL_IDS
GUILDSCRIBE_EMPTY_GRACE_MS
GUILDSCRIBE_HOOK_TIMEOUT_MS
GUILDSCRIBE_TRANSCRIPTION_HOOK
GUILDSCRIBE_HOOK_CHANNEL_JOINED
GUILDSCRIBE_HOOK_CHANNEL_LEFT
GUILDSCRIBE_HOOK_RECORDING_STARTED
GUILDSCRIBE_HOOK_RECORDING_COMPLETED
GUILDSCRIBE_HOOK_RECORDING_FAILED
GUILDSCRIBE_HOOK_TRANSCRIPTION_COMPLETED
GUILDSCRIBE_HOOK_TRANSCRIPTION_FAILED
```

`GUILDSCRIBE_VOICE_CHANNEL_IDS` contains a JSON array of one or more unique
Discord channel IDs. The legacy singular `GUILDSCRIBE_VOICE_CHANNEL_ID` remains
a read-only compatibility fallback when the plural key is absent.

`GUILDSCRIBE_OWNER_USER_ID` is optional. When configured, Guildscribe sends that
Discord user a direct message after the daemon establishes its initial gateway
connection and becomes ready. Notification failure is logged but does not stop
recording. Reconnects within the same daemon process do not send duplicates.

`GUILDSCRIBE_TRANSCRIPTION_HOOK` is an optional absolute executable path. When
it is absent, transcription is disabled. It is separate from the two
`HOOK_TRANSCRIPTION_*` lifecycle notifications. All hook values are absolute
executable paths. The default empty grace is 30 seconds and the default
lifecycle hook timeout is 30 seconds; that short timeout does not apply to the
transcription worker.

`guildscribe config show` is the safe read surface for configuration. It never
returns the Discord token. `guildscribe config update` accepts the same fields
as initialization, all optional, and atomically replaces `.env`; JSON `null`
clears an existing transcription or lifecycle hook. Channel ordering is
meaningful and is preserved. A successful update reports that a daemon restart
is required; it does not silently restart the recorder.

## SQLite storage and ownership

`<home>/guildscribe.sqlite` is the authoritative database. It belongs entirely
to Guildscribe; Saratonin is not a runtime dependency. The approved storage
boundary is searchable top-level facts in SQLite, detailed capture evidence in
files. `src/databaseWorker.ts` defines the exact SQL schema and migration version;
`src/storage.ts` owns access. Use `better-sqlite3` 12.10.0, pinned for Node 22.12
compatibility. All synchronous SQL runs in a dedicated worker thread. Connections
use foreign keys, WAL, a bounded five-second lock timeout, and owner-only files.
`PRAGMA user_version` tracks schema version 1; newer versions fail closed.

| Table                 | Row meaning and identity                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings`          | One recording UUID; channel/guild names, lifecycle, UTC millisecond timestamps, duration, recovery flag, error, unique home-relative directory.                                                                                                               |
| `transcripts`         | One queued recording UUID; pending/running/complete/failed, attempts, queue/start/finish timestamps, error, nullable language. No row means never queued.                                                                                                     |
| `transcript_segments` | One ordered segment; local integer primary key, recording ID, unique segment index within recording, start/end offsets, text, optional source interval ID and speaker user ID/username/display-name snapshots.                                                |
| `messages`            | One latest observed Discord message; local integer primary key, unique Discord message ID, guild/channel/thread context, author snapshot, bot/webhook/type fields, content, reply ID, creation/edit/observation timestamps, attachment and embed JSON arrays. |

Discord snowflakes are TEXT. Absolute timestamps are UTC Unix milliseconds;
segment offsets are recording-relative milliseconds. Transcript rows reference
recordings; segments reference transcripts. Segment replacement and terminal
transcript state commit together. Speaker snapshots derive from source interval
and participant files on publication; no source means null speaker fields.
Participants, presence sessions, speaking totals, and intervals are not database
tables. No full-transcript text is duplicated: read segments by `segment_index`.

`messages_fts` and `transcript_segments_fts` are rebuildable external-content
FTS5 indexes with the `unicode61` tokenizer. Transactional insert/update/delete
triggers keep them aligned; source text lives only in the ordinary tables.
For example:

```sql
SELECT s.recording_id, s.start_offset_ms, s.speaker_display_name, s.text
FROM transcript_segments_fts
JOIN transcript_segments s ON s.segment_id = transcript_segments_fts.rowid
WHERE transcript_segments_fts MATCH 'budget'
ORDER BY s.recording_id, s.segment_index;
```

Only Guildscribe lifecycle code writes authoritative rows. External tools and
hooks should open SQLite read-only. `databaseCall` supports a consistent SQLite
backup to a new destination; never copy only a live database file while WAL is
active. Keep media alongside database backups. Recording exports contain a
standalone `guildscribe.sqlite` with only that meeting and its transcript, plus
its media and detailed capture files. No messages or unrelated meetings leak
into an export.

### Legacy migration and recovery

After acquiring its single-daemon lock and before starting Discord or hook work,
the daemon validates all discovered legacy documents. It imports supported
canonical and legacy recording/transcription formats transactionally using
original IDs, and refuses duplicate directories, conflicting records, and
malformed data. It creates a private `legacy-storage-backup-*.json` recovery
bundle before import, marks that bundle committed after the SQL transaction,
and removes the old `recording.json`, `transcription.json`, `transcript.json`,
and `transcript.txt` only after successful import. Committed bundles journal
restartable cleanup. Keep these bundles as backups; they are not runtime data
sources. A pre-cutover read-only command can still inspect unmigrated files.

Database commits and directory renames cannot be one transaction. Startup
reconciles discovered recording directories with stored IDs before capture;
a completed directory move updates `directory_path` even if the previous process
stopped between rename and database update. MP3/PCM and participant/interval
files are never deleted by migration. Explicitly installing/running the upgraded
daemon performs migration; building this repository does not alter a live home.

### Discord message capture

`messageChannelIDs` in initialization/config updates maps to
`GUILDSCRIBE_MESSAGE_CHANNEL_IDS` (a JSON array encoded like the voice allowlist).
It defaults to `[]`. Capture includes those guild channels and accessible child
threads, independently of voice recording. Human, bot, and webhook messages are
retained. No DMs, history backfill, deletion tracking, read/unread state, or
attachment binary downloading is implemented.

When enabled, the bot requests GuildMessages and privileged MessageContent
intents. Enable Message Content in the Discord application settings and grant
View Channel and Read Message History; doctor checks configured message channels.
Voice-only configurations request no message intents. New messages and edits
upsert by Discord message ID without replacing the local search row ID. Partial
updates fetch the full message within the allowed scope; failed fetches are
reported without replacing saved content. Older edit revisions cannot overwrite
newer ones. Writes are ordered and drained on shutdown; failures are logged
without message text or attachment URLs. Offline gateway gaps are not backfilled.

## Contract locking

Guildscribe follows dmbridge's generated, reviewed contract snapshot pattern.
Runtime definitions remain authoritative: the command registry and protocol
schemas, document Zod validators, and the migration worker's actual SQLite DDL.
`scripts/contractCatalog.mjs` collects these definitions without duplicating them.

`test/snapshots/versions/` preserves immutable versioned contracts. The current
baseline is CLI schema 5 (envelope protocol 1), SQLite migration 1, and contract
version 1 for each captured document format. The generated `documents.json`
contains participants, intervals, transcription hook results, JSON transcript
exports, daemon locks and heartbeats, decoded history cursors, and migration
recovery bundles. Hook results have an out-of-band contract version; this does
not add a field to their payload. Other document contract versions track their
existing wire version. SQLite snapshots cover authored tables, constraints,
indexes, virtual FTS tables, and triggers; SQLite-generated shadow objects are
excluded.

`npm test` compares live definitions with current snapshots and their versioned
archives. `npm run contracts:update` preflights all existing archives and refuses
same-version changes before writing anything. To change a contract, advance its
own version, implement appropriate compatibility or migration behavior, generate
snapshots, and review the diff. Preserve old archives. A package-version bump
alone does not authorize changing a frozen contract. Tests use temporary homes;
updating snapshots never migrates an installed database.

Representative fixtures also exercise the real validators, including semantic
constraints that JSON Schema cannot represent. Existing recording, migration,
and CLI tests remain responsible for behavior beyond structural schemas.

## File documents and in-memory contracts

`participants.json` and every interval sidecar are versioned JSON documents.
Guildscribe writes its documents through a same-directory temporary file and
atomic rename. Every persistent document is parsed through a strict Zod schema
on read and write. Recording IDs are UUIDs and must match their directory;
Discord IDs are decimal snowflakes. `schemaVersion` is the document-format
version. Legacy documents using `version` remain readable.

The validated in-memory recording object maps to `recordings` columns. It is
not written to `recording.json`. Its shape is:

```json
{
  "schemaVersion": 1,
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "guildID": "111111111111111111",
  "guildName": "Example Guild",
  "channelID": "222222222222222222",
  "channelName": "Meeting Room",
  "status": "complete",
  "startedAt": "2026-11-05T12:00:00.000Z",
  "updatedAt": "2026-11-05T12:30:30.000Z",
  "endedAt": "2026-11-05T12:30:00.000Z",
  "durationMs": 1800000,
  "recoveredAfterRestart": false,
  "error": null
}
```

`updatedAt` is the last durable recording-row mutation, not general recording
activity. `endedAt` is the meeting boundary when the last human left and
excludes empty-channel grace and rendering time. Lifecycle validation requires
recording state to have no completion fields, finalizing and complete state to
have end and duration, and failed state to contain a sanitized error. Complete
recordings use the fixed filename `audio.mp3`; interval counts are derived from
the filesystem. Schema version 1 fixes PCM at signed 16-bit little-endian,
48 kHz stereo and does not make that format configurable.

Speaking interval sidecars record:

- interval and recording IDs;
- Discord user ID;
- meeting-relative start and end offsets;
- whether the interval ended incompletely.

Speaking PCM is always `intervals/<intervalID>.pcm`. Connection-gap sidecars use
the same timing fields with required reason `voiceDisconnected` and no speaker
or PCM payload. Usernames and display names live only in `participants.json`.

```json
{
  "schemaVersion": 1,
  "intervalID": "00000000-0000-4000-8000-000000000001",
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "kind": "speaking",
  "userID": "333333333333333333",
  "startOffsetMs": 12500,
  "endOffsetMs": 14750,
  "incomplete": false
}
```

```json
{
  "schemaVersion": 1,
  "intervalID": "00000000-0000-4000-8000-000000000002",
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "kind": "connectionGap",
  "startOffsetMs": 120000,
  "endOffsetMs": 128500,
  "incomplete": false,
  "reason": "voiceDisconnected"
}
```

`participants.json` contains one record for every human observed in the
meeting. Each participant has the most recently observed Discord username and
display name plus an ordered, non-overlapping list of presence sessions using
`startOffsetMs` and nullable `endOffsetMs`. Open sessions are closed at the
meeting end. Speaking duration is derived from interval sidecars rather than
stored redundantly. New recordings require nonempty names; legacy missing or
null names remain readable as null.

```json
{
  "schemaVersion": 1,
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "participants": [
    {
      "userID": "333333333333333333",
      "username": "speaker",
      "displayName": "Speaker",
      "sessions": [
        {
          "startOffsetMs": 0,
          "endOffsetMs": 1800000
        }
      ]
    }
  ]
}
```

`transcripts` stores lifecycle state and `transcript_segments` stores ordered
text and speaker snapshots. No transcript JSON or text projection is persisted. The transient
`.transcript-result.json.pending` file is an external hook response, not a
durable document.

## Recording lifecycle

Guildscribe subscribes to Discord's independent Opus receive stream for each
human speaker in the active channel. A speaking interval ends after 500
milliseconds of silence. The stream is decoded to signed 16-bit, 48 kHz stereo
PCM and its sidecar is checkpointed every two seconds.

The bot joins self-muted and not deafened. While idle, a voice-state event for
an occupied allowed channel selects that channel. On daemon startup or after a
recording finishes, if several allowed channels are already occupied, the first
one in configuration order wins. Once selected, the active channel remains
exclusive: activity in other allowed channels is ignored until the recording's
empty grace and finalization both finish.

When the active channel becomes empty Guildscribe keeps the grace boundary in
daemon memory and starts the configured grace timer. A returning human to that
channel clears the timer and continues the same meeting. Humans entering
another allowed channel do not cancel the active channel's grace. Grace expiry
uses the original boundary as the meeting end, disconnects the bot, closes
active intervals, and begins rendering.
After publication or failure, Guildscribe may immediately select another
occupied allowed channel.

Rendering mixes intervals at their meeting offsets, preserves simultaneous
speech, applies an FFmpeg limiter at 0.95, trims to the exact meeting duration,
and encodes 192 kbps MP3 with `libmp3lame`. `ffprobe` must report positive
duration before `audio.part.mp3` becomes `audio.mp3`.

After validation Guildscribe retains every PCM payload, commits complete recording
metadata, and atomically moves the recording directory beneath its year and
month. A failure leaves recoverable data in `in-progress` with a sanitized
failure in the database. PCM retention never depends on transcription state.

At daemon startup Guildscribe scans `in-progress`. A recording interrupted
during capture or empty-channel grace is marked `recoveredAfterRestart` and
rendered using its last durable interval offsets. A recording interrupted
during finalization is rendered again. A valid existing `audio.mp3` is reused.

## Event hooks

The current events are:

```text
channel.joined
channel.left
recording.started
recording.completed
recording.failed
transcription.completed
transcription.failed
```

`channel.joined` fires after a newly created Discord voice connection reaches
ready. `channel.left` fires after that announced connection is destroyed.
Ordinary transient connection-state changes that recover on the same connection
do not emit another pair. If recovery is abandoned and Guildscribe creates a
new connection, the actual departure and later ready connection each emit their
corresponding event.

Each configured executable receives the event name as its first argument, uses
the recording directory as its working directory, and receives one versioned
JSON event on stdin. Every version-2 payload includes the recording, guild, and active
channel IDs and `databasePath` instead of `manifestPath`. The child environment is restricted to ordinary process location
variables plus `GUILDSCRIBE_HOME` and `GUILDSCRIBE_EVENT`; it never contains the
Discord token.

Hooks run only after corresponding state is durable. Their stdout and stderr
are bounded and sent to Guildscribe diagnostics. A hook timeout or nonzero exit
does not change recording status. Delivery is best effort in this slice; users
can point a hook at a dispatcher when they need multiple actions or HTTP calls.

These lifecycle hooks are notifications. They are not the transcription
extension point, and configuring `recording.completed` never replaces or
implicitly enables transcription.

## Transcription hook

`GUILDSCRIBE_TRANSCRIPTION_HOOK` selects one executable worker. Omitting the
setting disables transcription. Guildscribe does not choose or bundle a model
adapter. The worker has its own durable lifecycle and is not subject to the
short lifecycle-hook timeout.

After a completed recording is durable, Guildscribe inserts a `transcripts` row
with status `pending` and schedules the recording on a single serial worker.
Enqueueing only waits for that state write; model work runs outside the Discord
capture loop. The states are `pending`, `running`, `complete`, and `failed`.
The validated state retains `attempts`, `queuedAt`, nullable `startedAt`, nullable
`finishedAt`, a sanitized nullable `error`, and a nullable `result`. Daemon
startup requeues `pending` work and converts an interrupted `running` state back
to `pending`. It does not automatically retry `failed` work or retroactively
enqueue recordings that predate configuration of the hook.

Guildscribe invokes the executable with exactly one positional argument:

```text
/absolute/path/to/transcription-hook /absolute/path/to/recording
```

The recording directory is also the child working directory. The executable
receives no request document on stdin. It discovers inputs through the durable
recording layout: `participants.json`, `audio.mp3`, and the JSON/PCM pairs
below `intervals/`. Recording metadata is available through read-only SQL using
`GUILDSCRIBE_DATABASE` and `GUILDSCRIBE_RECORDING_ID` in the hook environment.
These replace the former `recording.json` input; existing adapters must be
updated before enabling the upgraded daemon.

The restricted child environment contains ordinary process-location values and
the two database/recording references above; it never contains the Discord token. Before exiting successfully, the
executable atomically writes this complete result document to
`.transcript-result.json.pending`:

```json
{
  "language": "en",
  "segments": [
    {
      "startOffsetMs": 0,
      "endOffsetMs": 1200,
      "text": "Readable segment text.",
      "sourceIntervalID": "00000000-0000-4000-8000-000000000000"
    }
  ]
}
```

`language` is a nullable BCP 47 tag. `sourceIntervalID` is optional for
combined-audio transcription; when present, it must identify overlapping
speaking audio in the same recording. Speaker identity is resolved through the
source interval and `participants.json`; Guildscribe snapshots the resolved
speaker into segment columns for SQL-only searches. Segments must contain nonempty text, have positive nonnegative
ranges, be ordered by `startOffsetMs`, and remain within the recording
duration. Exit code zero is accepted only when the pending result exists and
passes this Zod-enforced schema.

The pending document is the hook's response; stdout and stderr are bounded
diagnostics only. The hook must not write the database. After it exits zero,
Guildscribe validates the result, snapshots speakers, and atomically commits
segments and status `complete`. The validated in-memory representation is:

```json
{
  "schemaVersion": 1,
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "status": "complete",
  "attempts": 1,
  "queuedAt": "2026-11-05T12:30:00.000Z",
  "startedAt": "2026-11-05T12:30:01.000Z",
  "finishedAt": "2026-11-05T12:31:00.000Z",
  "error": null,
  "result": {
    "language": "en",
    "segments": []
  }
}
```

`result` is null before completion and on failure. Failed work requires both
`finishedAt` and `error`; complete work requires `finishedAt` and `result`. The
hook must remain running until its atomic write is complete;
Guildscribe does not poll an invalid file indefinitely. A nonzero exit, spawn
failure, missing result, or invalid result
persists status `failed`. Graceful daemon shutdown returns an in-flight job to
`pending`. Audio, interval sidecars, and PCM are retained for every outcome.
The worker never creates FLAC, WAV, or consolidated per-speaker tracks.

After durable state is written, Guildscribe emits the best-effort
`transcription.completed` or `transcription.failed` lifecycle notification when
configured. Hook stdout and stderr are bounded diagnostics and are not result
transport.

### Planned asynchronous transcription callbacks

This is the approved contract for the next transcription slice and is not yet
implemented. Read/search/export and queued retry already exist as documented
under Local history and database operations; the callback mutations and the
partial-result retry semantics in this section remain future work. It will replace the synchronous `.transcript-result.json.pending`
response described above. The submission hook remains a short-lived executable:
it receives the recording directory, submits a durable job to Nightcrew or
another adapter, and exits. Exit zero means the external job was durably
accepted; it does not mean transcription completed. A nonzero exit marks the
attempt failed. The external job may outlive the submission process and the
Guildscribe daemon.

Guildscribe creates and increments the transcript attempt before invoking the
submission hook. There is no public `transcript start` command. External jobs
return results through these JSON-first commands:

```text
guildscribe transcript segment add --request <file-or-dash> [--dry-run]
guildscribe transcript complete --request <file-or-dash> [--dry-run]
guildscribe transcript fail --request <file-or-dash> [--dry-run]
guildscribe transcript get <recordingID> [--include-segments]
guildscribe transcript retry --request <file-or-dash> [--dry-run]
```

Structured mutation requests use a file or stdin as required by the CLI policy;
they never appear as plaintext JSON command-line arguments. Every finite command
returns the standard compact Guildscribe JSON envelope. Callback mutations validate the current attempt and atomically update
the SQLite transcript and segment rows in one transaction. No transcript JSON
or text projection will be persisted.

`transcript segment add` inserts one independently completed segment:

```json
{
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "attempt": 1,
  "segmentID": "stable-adapter-generated-id",
  "startOffsetMs": 0,
  "endOffsetMs": 1200,
  "text": "Readable segment text.",
  "sourceIntervalID": "00000000-0000-4000-8000-000000000001"
}
```

`segmentID` is a nonempty identifier generated deterministically by the adapter
and persisted with the segment. It identifies an asynchronous write;
`sourceIntervalID` independently identifies the captured audio source and
remains optional. Repeating the same `segmentID` with identical content is a
successful no-op. Reusing it with different content fails with a conflict.
Callbacks for any attempt other than the current attempt fail with a conflict.
New segments are stored in deterministic timeline order. They may arrive out of
order and may overlap because Discord speakers can speak simultaneously.

`transcript complete` marks the current attempt complete and optionally records
the detected language:

```json
{
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "attempt": 1,
  "language": "en"
}
```

`language` is a nullable BCP 47 tag. Completion validates the accumulated
segments before committing terminal state. A repeated identical completion is a successful no-op.

`transcript fail` marks the current attempt failed while retaining every
accepted partial segment:

```json
{
  "recordingID": "00000000-0000-4000-8000-000000000000",
  "attempt": 1,
  "error": "Granite process exited unexpectedly"
}
```

The persisted error is sanitized and bounded. A repeated identical failure is a
successful no-op. Completion and failure reject callbacks for stale attempts or
attempts already in a different terminal state.

`transcript get` is read-only. By default it returns lifecycle metadata,
language and segment count without returning meeting
content. `--include-segments` explicitly includes the structured segments; it
does not return audio or the Discord token.

`transcript retry` accepts:

```json
{
  "recordingID": "00000000-0000-4000-8000-000000000000"
}
```

Retry increments the attempt, invalidates callbacks from the prior external
job, retains accepted partial segments for resumable work, clears terminal
failure fields, and invokes the configured submission hook again. Stable
segment IDs make replayed accepted segments idempotent. Retry does not install,
start, or configure Nightcrew and never blocks Discord capture.

The asynchronous format revision will add `segmentID` to each persisted segment
and allow partial results while status is `running` or `failed`. Its schema
version and CLI schema version must advance when implemented. The implementation
must update the runtime command registry and contract snapshots in the same
change; this planned section alone does not advertise unimplemented callback commands through
`guildscribe help` or `guildscribe doctor`.

## Local history and database operations

The command catalog and published result/request schemas remain authoritative
in `src/commands.ts` and `src/protocol.ts`. `src/history.ts` owns local query,
export, retry-request, and database maintenance behavior. These commands work
without Discord access; only retry loads the configured transcription hook.
An absent database returns `database_not_found` without creating or migrating
anything. Start the daemon explicitly to initialize or import storage.

Message list/search accept channel and author filters. `--include-threads`
requires a channel and includes its directly nested threads. Transcript search
accepts channel and speaker user ID filters. Both accept `--after` (inclusive)
and `--before` (exclusive) ISO 8601 timestamps with explicit timezones. Message
date filters use Discord creation time; transcript filters use recording start
time. Search accepts FTS5 token, phrase, and boolean expressions, up to 1000
characters; malformed expressions produce an invalid-input error.

Pages default to 50 rows and allow 1–200 through `--limit`. Results contain
`items` and nullable `nextCursor`. Supply that cursor with the same search and
filters to continue. Messages sort oldest-first by creation time and message
ID; transcript matches sort by recording start, recording ID, and segment
index. Cursors use keyset pagination and are bound to the filters. They are
live traversal cursors, not frozen historical snapshots; edits and replacement
transcripts may change later results. Discord IDs remain strings; absolute
result timestamps are UTC Unix milliseconds.

Transcript reads return lifecycle metadata and segment count without content
by default. `--include-segments` adds a page of ordered segments, including
speaker snapshots; `--limit` and `--cursor` page those segments. Search results
include full matched text, speaker fields, recording/channel context, and
start/end offsets. Single-message reads include attachment metadata and embeds.

Completed transcripts can be exported to a new absolute file path with
`--format txt|json|srt|vtt` (default `txt`). JSON exports carry version 1,
metadata, and ordered segments; subtitles use recording-relative timing and
retain overlapping segments. Each export reports its byte count and SHA-256.
`--dry-run` validates and computes the export without creating a file. Existing
files are never overwritten. Exports are user-requested artifacts, not runtime
metadata replicas.

Retry takes `{ "recordingID": "<UUID>" }` via `--request <file-or-dash>`.
Only failed transcription transitions to pending; pending/running requests are
idempotent no-ops and completed transcription is rejected. The configured hook
and complete recording are required. `--dry-run` reports the pending plan
without changing state. An optimistic status/attempt condition prevents two
callers from requeuing the same failed attempt twice. Attempts increment when
the daemon actually starts the hook, not when the CLI queues it. The running
daemon checks durable pending requests every two seconds without overlapping
polls, and runs at most one hook. If it is stopped, work waits until the next
start. The CLI never launches a competing hook or starts the daemon itself.

Database status reports schema version, database/WAL sizes, and counts for the
four authoritative tables. Verification reads a consistent in-memory SQLite
snapshot and checks database integrity, foreign keys, and both external-content
FTS indexes against their source text. Its memory requirement scales with the
database size. Failed checks return `ok: false` and a nonzero exit; verification
does not repair indexes. Search rebuild is intentionally not exposed.

Database backup uses SQLite's online backup API, includes committed WAL data,
and publishes to a new absolute destination with exclusive creation. It reports
bytes and SHA-256. `--dry-run` checks paths without creating output. The backup
contains all local database content, including messages; media and participant/
interval files need separate backups. Finite command timeouts retain existing
unknown-outcome semantics for mutations: inspect the destination or retry state
before repeating a timed-out operation.

Examples:

```sh
guildscribe messages list --channel 222222222222222222 --limit 50
guildscribe messages search '"project budget"' --author 333333333333333333
guildscribe transcript get <recordingID> --include-segments
guildscribe transcript search budget --speaker 333333333333333333
guildscribe transcript export <recordingID> --format vtt --destination /absolute/path/meeting.vtt
guildscribe transcript retry --request /absolute/path/retry.json --dry-run
guildscribe database status
guildscribe database verify
guildscribe database backup --destination /absolute/path/guildscribe-backup.sqlite
```

## CLI

Guildscribe follows dmbridge's agent-safe conventions:

```text
guildscribe help [scope...]
guildscribe version
guildscribe init --request <file-or-dash> [--dry-run]
guildscribe doctor [--schema <name>]
guildscribe status
guildscribe config show
guildscribe config update --request <file-or-dash> [--dry-run]
guildscribe recordings list
guildscribe recordings show <recordingID>
guildscribe recordings verify <recordingID>
guildscribe recordings export <recordingID> --destination <absolute-path> [--wav] [--dry-run]
guildscribe daemon run
guildscribe startup install [--dry-run]
guildscribe startup uninstall
guildscribe startup status
guildscribe startup start
guildscribe startup stop
guildscribe startup restart
guildscribe startup logs [--lines <count>]
```

Shared options are:

```text
-h, --help
-V, --version
--home <absolute-path>
--request-id <ID>
--timeout <duration-with-unit>
--no-input
--non-interactive
--quiet
--verbose
--verbosity <quiet|normal|verbose|debug>
```

Finite commands emit one compact protocol-version-1 JSON envelope on stdout.
Presentation formatting belongs to the caller. Errors use stable codes,
structured details, exit classes, and `safe`, `unsafe`, or `never` retry
classifications. Diagnostics use stderr. Secrets never appear in output. CLI
schema version 5 is independently discoverable through doctor.

### Recording inventory

`recordings list` discovers both published recordings and recoverable
directories under `in-progress`. It returns records ordered by descending
`startedAt` plus aggregate totals. Each record reports its storage class,
manifest lifecycle fields, combined-audio byte size, PCM file count and byte
size, transcription status, transcript segment count, total file count, and total
bytes for the entire recording directory.

`recordings show <recordingID>` returns the same record shape for one exact
recording ID. Missing IDs fail with `recording_not_found`; an ID present in
more than one storage location fails with `recording_ambiguous`. These commands
only inspect filesystem metadata and never read or expose captured audio or
transcript contents.

### Operational status

`guildscribe status` reads durable state and reports daemon liveness, uptime,
heartbeat time, Discord readiness, last sanitized runtime error, and one health
classification: `stopped`, `starting`, `ready`, `recording`, `degraded`,
`stopping`, or `stale`. It also reports the configured channel allowlist,
whether transcription is enabled, the active recording, the latest published
recording, and aggregate storage totals. Empty-channel grace is intentionally
ephemeral daemon state and is not reported from disk.
It never contacts Discord, returns the token, or mutates state. A malformed
lock is not proof that a daemon exists; a live lock without a current,
PID-matched heartbeat is `stale`.

### Recording verification and export

`recordings verify` is read-only. It validates manifest identity and lifecycle,
interval sidecars and counts, PCM existence and stereo-frame alignment,
connection-gap invariants, combined MP3 duration through FFprobe, participant
metadata, the complete transcript schema and source references, and exact
stored transcript segments and source-interval consistency. It also returns byte counts and SHA-256
digests for every durable file. Failed checks make the command envelope
unsuccessful without changing the recording.

`recordings export` copies one recording into a new absolute destination and
writes `checksums.sha256`. It excludes pending transcription responses and
never changes the source recording. The destination must not already exist or
be inside the source. `--dry-run` returns the plan without writing. `--wav`
uses the mandatory FFmpeg installation to add a portable PCM WAV copy; WAV is
an export convenience and is never stored as a canonical recording artifact.
If export fails, Guildscribe removes only the newly created partial destination.

### Initialization

`guildscribe init` reads a JSON request from a file or stdin:

```json
{
  "discordToken": "...",
  "ownerUserID": "157904074535206912",
  "voiceChannelIDs": ["...", "..."],
  "emptyGraceMs": 30000,
  "transcriptionHook": "/absolute/path/to/transcribe",
  "hooks": {
    "channelJoined": "/absolute/path/to/hook",
    "channelLeft": "/absolute/path/to/hook",
    "recordingCompleted": "/absolute/path/to/hook"
  }
}
```

The token and at least one unique channel ID are required. The owner user ID is
optional and enables the one-time online direct message. Initialization
validates everything, creates the runtime home and artifact directories, and
creates `.env` exclusively. If `.env` already exists, initialization fails
without changing it. `--dry-run` creates nothing. Initialization does not
contact Discord.

Configuration updates use the same structured-request rule: new secrets may
only arrive through a JSON file or stdin, never a command-line value. Unknown
fields and empty update objects are rejected. `--dry-run` validates and returns
the fully merged redacted configuration without changing `.env`.

### Doctor

`guildscribe doctor` reports individual checks for:

1. runtime-home and `.env` existence and restrictive permissions;
2. valid configuration and writable artifact directories;
3. executable configured lifecycle and transcription hooks;
4. `ffmpeg -version`;
5. `ffprobe -version`;
6. Discord bot-token authentication;
7. every configured voice channel's existence and type; and
8. the bot's View Channel and Connect permissions for every configured channel.

The token is redacted from all results and diagnostics. Any failed check makes
the command unsuccessful while preserving every individual check result.

## macOS startup

`scripts/installLaunchAgent.sh` builds Guildscribe and invokes `guildscribe
startup install`. Installation requires an initialized runtime home and writes
`~/Library/LaunchAgents/dev.guildscribe.daemon.plist` with mode `0600`. The
plist contains no Discord token. It launches `/bin/bash scripts/daemon`, the
selected runtime home, and the exact Node executable used for installation.

The reusable `src/macosLaunchAgent.ts` module owns plist rendering, atomic
installation, launchctl calls, and stable status parsing. It contains no
Guildscribe paths or bot behavior. `src/startup.ts` supplies the Guildscribe
label, wrapper, working directory, and log paths. `scripts/daemon` establishes
a predictable system and Homebrew PATH before executing `guildscribe daemon
run`; the bot process owns all Discord behavior.

The agent uses `RunAtLoad`, a 30-second launchd throttle, and a `KeepAlive`
condition that restarts only after an unsuccessful exit. A crash is therefore
restarted, while `startup stop` sends SIGTERM and the daemon's clean exit keeps
it stopped. `startup start` or `startup restart` resumes it. Process type is
`Standard` because live voice capture should not be background-throttled.

`startup uninstall` unloads the agent and removes only its plist. It never
removes `.env`, recordings, in-progress recovery data, or logs. The scripts
must run as the logged-in user and reject root execution.

## Packaging, releases, upgrade, and uninstall

The npm package name and executable are both `guildscribe`. Published packages
contain compiled JavaScript, the canonical specification, launchd helpers, and
user-facing maintenance scripts; runtime data, source, tests, release builders,
and CI files are never packaged. `npm run test:package` inspects an actual
tarball, installs it with lifecycle scripts disabled, and smoke-tests its
`guildscribe version` and `guildscribe help` commands. `npm run package:npm`
writes the tarball and a SHA-256 sidecar below ignored `artifacts/`.

Push and pull-request CI runs with read-only repository permissions. Tags
matching `v<package-version>` run the release workflow. Its read-only job checks
the tag, type-checks, tests, smoke-tests the package, and builds artifacts. Only
the dependent publish job receives release, identity-token, and attestation
permissions before publishing the attested tarball and checksum. npm registry
publication is deliberately not automated by this slice.

`scripts/upgradeGlobal.sh` upgrades the globally installed npm package and
reinstalls the per-user LaunchAgent so its executable paths match the new
installation. `scripts/uninstallGlobal.sh` removes the LaunchAgent and global
package. Both reject root execution. Neither script removes `.env`, logs,
in-progress recovery state, recordings, exports, or any other runtime data.

## Transcription and Nightcrew boundary

Guildscribe owns transcript state and text in SQLite. It does not persist
duplicate transcript JSON or text files.
Speaker identity is optional: a segment with `sourceIntervalID` resolves its
Discord user through the interval sidecar, while unattributed mixed-audio
segments omit that property.

For Discord recordings, Guildscribe passes the recording-directory path to the
configured transcription hook. The hook can read retained speaker-attributed
PCM intervals and their meeting-relative timing from that directory. A
separately installed hook may submit a durable job to Nightcrew.
When used, Nightcrew owns the shared llama.cpp router, the `granite.audio`
inference lane, model loading and unloading, request priority, and
desktop-presence gating. Unknown or unhealthy presence fails closed in
Nightcrew; a returning user stops Granite work at a recoverable chunk boundary.

Guildscribe remains the source of truth for recording identity, Discord speaker
metadata, transcript status, and stored transcript text. Neither Nightcrew
nor a custom hook may write database rows directly. The configured
hook returns structured text and timing results through the pending-file
contract. Guildscribe validates and promotes that response atomically, then
emits transcription lifecycle hooks only after the corresponding state is
durable.

Nightcrew client transport and its own job-resumption behavior belong to the
external adapter. Guildscribe continues recording when Nightcrew or a custom
hook is absent, stopped, busy, or unhealthy; transcription stays pending,
failed, or disabled without invalidating the audio artifact.

No reasoning stage follows transcription.

## Acceptance criteria for this slice

- Initialization never exposes the token or overwrites existing `.env`.
- Doctor identifies missing tools and invalid Discord configuration precisely.
- A human joining an allowed channel causes idle Guildscribe to join and record.
- Activity in another allowed channel never creates a concurrent recording.
- A returning human within the empty grace continues the same recording.
- Simultaneous speakers remain represented as independent intervals.
- A completed meeting produces a validated, playable combined MP3.
- Restarting during capture retains and renders the captured portion.
- Recording hooks cannot invalidate completed media.
- Status, configuration reads, and inventory never reveal the Discord token.
- Configuration updates are atomic, previewable, and preserve channel order.
- Participant join/leave history remains available without reading audio or
  transcript contents, and speaking duration is derivable from intervals.
- Verification is read-only and detects missing or malformed recording
  artifacts.
- Export creates a checksummed portable copy without changing its source.
- An omitted transcription hook leaves capture fully functional and creates no
  transcription state.
- A configured transcription hook receives the recording directory and can
  discover combined audio, retained PCM, timing, and optional speaker identity.
- Pending or interrupted transcription survives restart, while failed work
  remains inspectable and is not retried automatically.
- Valid pending output commits transcript rows without deleting PCM.
- The packed npm CLI excludes source and build tooling, installs with lifecycle
  scripts disabled, then explicitly rebuilds only better-sqlite3, exercises the
  packaged database worker, and returns valid JSON version and help envelopes.
- SQLite metadata/text and file-backed capture detail remain standalone.
- Message edits update FTS without duplicating message rows.
- Migration is backed up, idempotent, and resumable across cleanup interruption.
