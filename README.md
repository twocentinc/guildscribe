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
- `guildscribe status` and `guildscribe config show|update` for safe recorder
  operations;
- `guildscribe recordings list|show|verify|export` for JSON inventories,
  integrity checks, and portable checksummed copies;
- `guildscribe daemon run` for automatic voice-channel recording;
- `guildscribe startup` commands and install scripts for macOS LaunchAgent
  supervision;
- recoverable, permanently retained per-speaker PCM intervals with atomic JSON
  manifests, participant presence metadata, and FFmpeg-rendered combined MP3
  recordings;
- executable event hooks for channel and recording lifecycle events; and
- an optional durable transcription worker that validates and publishes
  `transcript.json` and `transcript.txt` from one configured executable.

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

Initialize from a JSON request without putting the token in shell history:

```sh
printf '%s' '{"discordToken":"...","voiceChannelIDs":["..."]}' |
  node dist/index.js init --request -

node dist/index.js doctor --pretty
node dist/index.js status --pretty
node dist/index.js config show --pretty
node dist/index.js recordings list --pretty
node dist/index.js recordings show <recordingID> --pretty
node dist/index.js recordings verify <recordingID> --pretty
node dist/index.js daemon run
```

`recordings list` includes published and recoverable in-progress recordings,
with aggregate file, MP3, and retained PCM counts and byte sizes. `recordings
show` returns the same storage summary for one recording ID.

Update configuration atomically from JSON, then restart the daemon when the
result reports `restartRequired`:

```sh
printf '%s' '{"voiceChannelIDs":["..."]}' |
  node dist/index.js config update --request - --pretty
node dist/index.js startup restart --pretty
```

Create a portable copy without touching the source recording:

```sh
node dist/index.js recordings export <recordingID> \
  --destination /absolute/path/to/export --pretty
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

After publication, Guildscribe invokes the hook outside the capture loop and
passes a versioned JSON request on stdin. See
[the specification](docs/spec.md#transcription-hook) for the exact contract.

The default runtime home is `~/.guildscribe`. Use `--home <absolute-path>` for
an isolated installation.

## macOS startup

After initialization and a successful doctor check, install the per-user
LaunchAgent:

```sh
./scripts/installLaunchAgent.sh --pretty
node dist/index.js startup status --pretty
```

The LaunchAgent starts Guildscribe at login and restarts it after an
unexpected failure. It runs `scripts/daemon`; Discord-specific work remains in
`guildscribe daemon run`. Manage it with `guildscribe startup
start|stop|restart|status|logs`. Remove only the startup registration with:

```sh
./scripts/uninstallLaunchAgent.sh --pretty
```

Uninstalling the LaunchAgent does not remove configuration, recordings, or
logs. Diagnostics are stored under `~/.guildscribe/logs`.

## Distribution

Test the real packed CLI, or create a checksummed release artifact:

```sh
npm run test:package
npm run package:release
```

For a globally installed package, `scripts/upgradeGlobal.sh` upgrades
Guildscribe and refreshes the LaunchAgent. `scripts/uninstallGlobal.sh` removes
the LaunchAgent and npm package while preserving `~/.guildscribe` in full.
Tagged releases run the same checks and attach an attested tarball plus SHA-256
checksum to GitHub; npm registry publication remains a deliberate manual step.
