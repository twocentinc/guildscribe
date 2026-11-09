# Guildscribe

Guildscribe is a self-hosted Discord bot that records voice meetings while
preserving Discord speaker identity. It renders a combined MP3 with FFmpeg and
supports optional local transcription through a replaceable executable hook.
The hook may call Nightcrew or any other transcription service without adding
model management, meeting summaries, or cloud dependencies to Guildscribe.

The detailed product and architecture contract is in
[docs/spec.md](docs/spec.md).

## Current implementation

The first working slice provides:

- `guildscribe init` for owner-only `.env` configuration;
- `guildscribe doctor` for local tools and live Discord validation;
- `guildscribe status` with durable daemon/Discord health, plus
  `guildscribe config show|update` for safe recorder operations;
- `guildscribe recordings list|show|verify|export` for JSON inventories,
  integrity checks, and portable checksummed copies;
- `guildscribe daemon run` for automatic voice-channel recording;
- `guildscribe startup` commands and install scripts for macOS LaunchAgent
  supervision;
- recoverable, permanently retained per-speaker PCM intervals with atomic JSON
  interval sidecars, participant presence metadata, and FFmpeg-rendered combined MP3
  recordings;
- executable event hooks for channel and recording lifecycle events; and
- an optional durable transcription worker that validates and stores transcript
  state, text, timing, and speaker snapshots in SQLite;
- optional Discord message capture with local SQLite full-text search.

Transcription is disabled unless `transcriptionHook` is supplied during
initialization. Guildscribe does not bundle a model or Nightcrew adapter.

## Prerequisites

- Node.js 22.12 or newer
- `ffmpeg`
- `ffprobe`

Guildscribe verifies these programs but does not install them. Nightcrew and
Granite are optional and are not required for capture. A transcription hook
may use either of them, another local tool, or a remote service.

## Setup

```sh
npm install
npm run build
```

Discover commands and machine-readable contracts without parsing prose:

```sh
node dist/index.js help
node dist/index.js recordings --help
```

Initialize from a JSON request without putting the token in shell history:

```sh
printf '%s' '{"discordToken":"...","voiceChannelIDs":["..."]}' |
  node dist/index.js init --request -

node dist/index.js doctor --schema init.request
node dist/index.js status
node dist/index.js config show
node dist/index.js recordings list
node dist/index.js recordings show <recordingID>
node dist/index.js recordings verify <recordingID>
node dist/index.js daemon run
```

`recordings list` includes published and recoverable in-progress recordings,
with aggregate file, MP3, and retained PCM counts and byte sizes. `recordings
show` returns the same storage summary for one recording ID.

Update configuration atomically from JSON, then restart the daemon when the
result reports `restartRequired`:

```sh
printf '%s' '{"voiceChannelIDs":["..."]}' |
  node dist/index.js config update --request -
node dist/index.js startup restart
```

Create a portable copy without touching the source recording:

```sh
node dist/index.js recordings export <recordingID> \
  --destination /absolute/path/to/export
```

To enable transcription, add an absolute executable path to the initialization
request:

```json
{
  "discordToken": "...",
  "voiceChannelIDs": ["..."],
  "transcriptionHook": "/absolute/path/to/transcribe"
}
```

After publication, Guildscribe invokes the hook outside the capture loop with
the recording directory as its only argument. The hook atomically writes the
complete result to `.transcript-result.json.pending`; Guildscribe validates it,
commits it to SQLite, and removes the temporary result. The hook receives
`GUILDSCRIBE_DATABASE` and `GUILDSCRIBE_RECORDING_ID` for read-only metadata
queries; `recording.json` is no longer supplied. See
[the specification](docs/spec.md#transcription-hook) for the exact contract.

The default runtime home is `~/.guildscribe`. Use `--home <absolute-path>` for
an isolated installation. The database is `guildscribe.sqlite` inside that home.
On the next daemon start, legacy recording/transcript JSON is validated, backed
up, imported, and removed; media and participant/interval files stay in place.
Update existing hooks to use the database before starting the upgraded daemon.

To capture text, set `messageChannelIDs` through `config update` and enable the
bot's Message Content intent in Discord. The allowlist includes accessible child
threads. An empty list (the default) leaves text capture disabled. Message text,
attachment metadata, and embeds are stored locally; attachment binaries and
historical messages are not downloaded.

## Search, export, and database operations

All commands return the standard JSON envelope. Reads use local SQLite and
require no Discord connection.

```sh
guildscribe messages list --channel 222222222222222222 --limit 50
guildscribe messages get <messageID>
guildscribe messages search budget --author 333333333333333333
guildscribe transcript get <recordingID> --include-segments
guildscribe transcript search budget --speaker 333333333333333333
guildscribe transcript export <recordingID> --format srt --destination /absolute/path/meeting.srt
guildscribe transcript retry --request /absolute/path/retry.json --dry-run
guildscribe database status
guildscribe database verify
guildscribe database backup --destination /absolute/path/backup.sqlite
```

List/search pages include `nextCursor`; use `--cursor` with the same filters.
Exports also support TXT, JSON, and VTT, never overwrite files, and support
`--dry-run`. Retry requests contain `{ "recordingID": "<UUID>" }` and queue
failed work for the daemon; they do not start a daemon or a second hook process.
Database backups include messages and transcripts, but not recording media.
Verification checks search indexes without repairing them. See the
[specification](docs/spec.md#local-history-and-database-operations) for filtering,
pagination, retry, and backup semantics.

## macOS startup

After initialization and a successful doctor check, install the per-user
LaunchAgent:

```sh
./scripts/installLaunchAgent.sh
node dist/index.js startup status
```

The LaunchAgent starts Guildscribe at login and restarts it after an
unexpected failure. It runs `scripts/daemon`; Discord-specific work remains in
`guildscribe daemon run`. Manage it with `guildscribe startup
start|stop|restart|status|logs`. Remove only the startup registration with:

```sh
./scripts/uninstallLaunchAgent.sh
```

Uninstalling the LaunchAgent does not remove configuration, recordings, or
logs. Diagnostics are stored under `~/.guildscribe/logs`.

## Distribution

Test the real packed CLI, or create a checksummed release artifact:

```sh
npm run test:package
npm run package:npm
```

For a globally installed package, `scripts/upgradeGlobal.sh` upgrades
Guildscribe and refreshes the LaunchAgent. `scripts/uninstallGlobal.sh` removes
the LaunchAgent and npm package while preserving `~/.guildscribe` in full.
Tagged releases run the same checks and attach an attested tarball plus SHA-256
checksum to GitHub; npm registry publication remains a deliberate manual step.

Contract snapshots freeze the CLI, JSON document formats, and SQLite layout.
Run `npm test` to check them; intentional versioned changes use
`npm run contracts:update`. See [contract locking](docs/spec.md#contract-locking).
