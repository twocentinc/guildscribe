# Guildscribe

Guildscribe is a self-hosted Discord bot that records voice meetings while
preserving Discord speaker identity. It renders a combined MP3 with FFmpeg and
supports optional local transcription through a replaceable executable hook.
The default hook uses Nightcrew, without adding meeting summaries or cloud
model dependencies to Guildscribe.

The detailed product and architecture contract is in
[docs/spec.md](docs/spec.md).

## Current implementation

The first working slice provides:

- `guildscribe init` for owner-only `.env` configuration;
- `guildscribe doctor` for local tools and live Discord validation;
- `guildscribe recordings list|show` for JSON recording and storage
  inventories;
- `guildscribe daemon run` for automatic voice-channel recording;
- `guildscribe startup` commands and install scripts for macOS LaunchAgent
  supervision;
- recoverable, permanently retained per-speaker PCM intervals with atomic JSON
  manifests and FFmpeg-rendered combined MP3 recordings; and
- executable event hooks for channel and recording lifecycle events.

The transcription-hook worker and bundled Nightcrew adapter are specified but
not implemented in this slice.

## Prerequisites

- Node.js 22.12 or newer
- `ffmpeg`
- `ffprobe`

Guildscribe verifies these programs but does not install them. Nightcrew and
Granite are optional and are not required for capture. Once the transcription
slice is implemented, an owner may replace Nightcrew with a custom executable
or disable transcription.

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
node dist/index.js recordings list --pretty
node dist/index.js recordings show <recordingID> --pretty
node dist/index.js daemon run
```

`recordings list` includes published and recoverable in-progress recordings,
with aggregate file, MP3, and retained PCM counts and byte sizes. `recordings
show` returns the same storage summary for one recording ID.

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
