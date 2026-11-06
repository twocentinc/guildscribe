# Guildscribe specification

Status: implementation contract for recording, recorder operations, optional
executable-hook transcription, and standalone distribution.

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
- records versioned participant presence history and speaking duration;
- exposes redacted configuration, live status, artifact verification, and
  portable checksummed exports through agent-safe JSON commands;
- invokes optional local executable hooks for recording events; and
- durably queues one optional transcription executable at a time, validates its
  staged result, and publishes canonical transcript files; and
- packages as an npm CLI and provides macOS startup, upgrade, and uninstall
  workflows that preserve runtime data.

Bundled Nightcrew integration, speaker-track publication, transcript merging,
and reasoning stages are not implemented.

## Non-goals

- Meeting bullets, summaries, action items, or reasoning output.
- User-defined stages or arbitrary processing pipelines.
- Model installation, downloading, or server management.
- Installing FFmpeg, Nightcrew, llama.cpp, or model weights.
- A web dashboard.
- A database or query service.
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
  guildscribe.lock
  logs/
    daemon.jsonl
    daemon.jsonl.1
    launchd.stdout.log
    launchd.stderr.log
  in-progress/
    <recordingID>/
      recording.json
      participants.json
      intervals/
        <intervalID>.json
        <intervalID>.pcm
      audio.part.mp3
  recordings/
    <year>/
      <month>/
        <recordingID>/
          recording.json
          participants.json
          transcription.json
          transcript.json
          transcript.txt
          intervals/
            <intervalID>.json
            <intervalID>.pcm
          audio.mp3
```

`guildscribe.lock` exists only while the daemon is running and contains a
versioned JSON record with its process ID and start time. Completed raw PCM
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
GUILDSCRIBE_VOICE_CHANNEL_IDS
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

## Persistent documents

`recording.json`, `participants.json`, `transcription.json`, `transcript.json`,
and every interval sidecar are versioned JSON documents.
Guildscribe writes them through a same-directory temporary file and atomic
rename. The recording manifest records identity, lifecycle state, timestamps,
duration, final audio filename, interruption status, and sanitized failure.

Speaking interval sidecars record:

- interval and recording IDs;
- Discord user ID, username, and display name;
- meeting-relative start and end offsets;
- PCM filename while capture is in progress; and
- whether the interval ended incompletely.

Connection-gap sidecars use the same timing fields with a gap reason and no
speaker. Display names never appear in filenames.

`participants.json` contains one record for every human observed in the
meeting. Each participant has Discord identity metadata, an ordered list of
join/leave sessions, and total speaking duration derived from durable speaking
intervals. Open sessions are closed at the meeting end. This document is
meeting metadata, not a transcript and not a replacement for interval timing.

`transcription.json` records the independent worker state, attempt count,
timestamps, and sanitized failure. `transcript.json` contains the validated
version-1 transcript document; `transcript.txt` is its readable text projection.
The temporary `.transcription-staging` directory is removed after successful
publication and may remain after failure for inspection.

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

When the active channel becomes empty Guildscribe persists `emptySince` and
starts the configured grace timer. A returning human to that channel clears the
value and continues the same meeting. Humans entering another allowed channel
do not cancel the active channel's grace. Grace expiry uses `emptySince` as the
meeting end, disconnects the bot, closes active intervals, and begins rendering.
After publication or failure, Guildscribe may immediately select another
occupied allowed channel.

Rendering mixes intervals at their meeting offsets, preserves simultaneous
speech, applies an FFmpeg limiter at 0.95, trims to the exact meeting duration,
and encodes 192 kbps MP3 with `libmp3lame`. `ffprobe` must report positive
duration before `audio.part.mp3` becomes `audio.mp3`.

After validation Guildscribe retains every PCM payload, writes the complete
manifest, and atomically moves the recording directory beneath its year and
month. A failure leaves recoverable data in `in-progress` with a sanitized
failure in the manifest. PCM retention never depends on transcription state.

At daemon startup Guildscribe scans `in-progress`. A recording interrupted
during capture is marked interrupted and rendered using its last durable
interval offsets. A recording interrupted during finalization is rendered
again. A valid existing `audio.mp3` is reused.

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
JSON event on stdin. Every payload includes the recording, guild, and active
channel IDs. The child environment is restricted to ordinary process location
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

After a completed recording is durable, Guildscribe writes
`transcription.json` with status `pending` and schedules the recording on a
single serial worker. Enqueueing only waits for that state write; model work
runs outside the Discord capture loop. The states are `pending`, `running`,
`complete`, and `failed`, with attempt count, timestamps, and a sanitized error.
Daemon startup requeues `pending` work and converts an interrupted `running`
state back to `pending`. It does not automatically retry `failed` work or
retroactively enqueue recordings that predate configuration of the hook.

The executable receives `transcribe` as its first argument, uses the recording
directory as its working directory, and receives one protocol-version-1 JSON
request on stdin:

```json
{
  "version": 1,
  "protocolVersion": 1,
  "recording": {
    "recordingID": "...",
    "guildID": "...",
    "channelID": "...",
    "startedAt": "2026-11-05T12:00:00.000Z",
    "endedAt": "2026-11-05T12:30:00.000Z",
    "durationMs": 1800000,
    "audio": {
      "mediaType": "audio/mpeg",
      "path": "/absolute/recording/path/audio.mp3"
    },
    "intervals": [
      {
        "intervalID": "...",
        "kind": "speaking",
        "userID": "...",
        "username": "speaker",
        "displayName": "Speaker",
        "startOffsetMs": 0,
        "endOffsetMs": 1200,
        "incomplete": false,
        "reason": null,
        "pcmPath": "/absolute/recording/path/intervals/example.pcm",
        "pcm": {
          "channels": 2,
          "encoding": "signed-16-bit-little-endian",
          "sampleRateHz": 48000
        }
      }
    ]
  },
  "output": {
    "transcriptJSONPath": "/absolute/recording/path/.transcription-staging/transcript.json"
  }
}
```

Connection-gap intervals have `pcmPath` and `pcm` set to `null`. The restricted
child environment contains ordinary process-location values plus
`GUILDSCRIBE_HOME` and `GUILDSCRIBE_RECORDING_ID`; it never contains the Discord
token.

Before exiting successfully, the executable writes this strict result document
to `output.transcriptJSONPath`:

```json
{
  "version": 1,
  "language": "en",
  "text": "Readable full transcript.",
  "segments": [
    {
      "startOffsetMs": 0,
      "endOffsetMs": 1200,
      "text": "Readable segment text.",
      "speaker": {
        "userID": "...",
        "username": "speaker",
        "displayName": "Speaker"
      }
    }
  ]
}
```

`language` may be `null`; `speaker` is optional and its identity fields may be
`null`. Segments must have valid nonnegative ranges, be ordered by
`startOffsetMs`, and remain within the recording duration. Exit code zero is
accepted only when the staged document exists and passes this schema.

Guildscribe adds `recordingID` and `createdAt`, atomically writes the canonical
`transcript.json`, derives `transcript.txt` from `text`, then persists status
`complete`. A nonzero exit, spawn failure, missing result, or invalid result
persists status `failed`. Graceful daemon shutdown returns an in-flight job to
`pending`. Audio, interval sidecars, and PCM are retained for every outcome.
The worker never creates FLAC, WAV, or consolidated per-speaker tracks.

After durable state is written, Guildscribe emits the best-effort
`transcription.completed` or `transcription.failed` lifecycle notification when
configured. Hook stdout and stderr are bounded diagnostics and are not result
transport.

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
--pretty
--timeout <duration-with-unit>
--no-input
--non-interactive
--quiet
--verbose
--verbosity <quiet|normal|verbose|debug>
```

Finite commands emit one protocol-version-1 JSON envelope on stdout. Errors
use stable codes, structured details, exit classes, and `safe`, `unsafe`, or
`never` retry classifications. Diagnostics use stderr. Secrets never appear in
output. Schema version 1 is independently discoverable through doctor.

### Recording inventory

`recordings list` discovers both published recordings and recoverable
directories under `in-progress`. It returns records ordered by descending
`startedAt` plus aggregate totals. Each record reports its storage class,
manifest lifecycle fields, combined-audio byte size, PCM file count and byte
size, transcription status, transcript byte sizes, total file count, and total
bytes for the entire recording directory.

`recordings show <recordingID>` returns the same record shape for one exact
recording ID. Missing IDs fail with `recording_not_found`; an ID present in
more than one storage location fails with `recording_ambiguous`. These commands
only inspect filesystem metadata and never read or expose captured audio or
transcript contents.

### Operational status

`guildscribe status` reads durable state and reports daemon liveness and
uptime, the configured channel allowlist, whether transcription is enabled,
the active recording and any empty-channel grace deadline, the latest
published recording, and aggregate storage totals. It never contacts Discord,
returns the token, or mutates state. A stale or malformed lock is reported as
not running rather than treated as proof that a daemon exists.

### Recording verification and export

`recordings verify` is read-only. It validates manifest identity and lifecycle,
interval sidecars and counts, PCM existence and stereo-frame alignment,
connection-gap invariants, combined MP3 duration through FFprobe, participant
metadata, and transcript consistency. It also returns byte counts and SHA-256
digests for every durable file. Failed checks make the command envelope
unsuccessful without changing the recording.

`recordings export` copies one recording into a new absolute destination and
writes `checksums.sha256`. It excludes transient transcription staging and
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

The token and at least one unique channel ID are required. Initialization validates everything,
creates the runtime home and artifact directories, and creates `.env`
exclusively. If `.env` already exists, initialization fails without changing
it. `--dry-run` creates nothing. Initialization does not contact Discord.

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

Guildscribe publishes `transcript.json` as the canonical versioned document and
`transcript.txt` as a readable projection. Speaker is an optional
transcript-segment field so unattributed results still use the format.

For Discord recordings, Guildscribe passes the retained speaker-attributed PCM
intervals and their meeting-relative timing to the configured transcription
hook. A separately installed hook may submit a durable job to Nightcrew.
When used, Nightcrew owns the shared llama.cpp router, the `granite.audio`
inference lane, model loading and unloading, request priority, and
desktop-presence gating. Unknown or unhealthy presence fails closed in
Nightcrew; a returning user stops Granite work at a recoverable chunk boundary.

Guildscribe remains the source of truth for recording identity, Discord speaker
metadata, transcript status, and published transcript files. Neither Nightcrew
nor a custom hook may publish directly over canonical files. The configured
hook returns structured text and timing results through the staging contract;
Guildscribe validates and promotes them atomically, then emits transcription
lifecycle hooks only after the corresponding state is durable.

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
- Participant join/leave history and speaking duration remain available without
  reading audio or transcript contents.
- Verification is read-only and detects missing or malformed recording
  artifacts.
- Export creates a checksummed portable copy without changing its source.
- An omitted transcription hook leaves capture fully functional and creates no
  transcription state.
- A configured transcription hook receives combined audio, retained PCM,
  timing, and optional speaker identity through the versioned request.
- Pending or interrupted transcription survives restart, while failed work
  remains inspectable and is not retried automatically.
- Valid staged output publishes canonical JSON and text without deleting PCM.
- The packed npm CLI excludes source and build tooling, installs with lifecycle
  scripts disabled, and returns valid JSON version and help envelopes.
- No SQLite database or runtime dependency is created.
