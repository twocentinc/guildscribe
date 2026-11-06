# Guildscribe specification

Status: implementation contract for the first recording slice, with a
replaceable transcription hook retained as the next product boundary.

## Product definition

Guildscribe is a self-hosted Discord bot that records meetings from a configured
voice-channel allowlist. It joins and records only one channel at a time.
Discord supplies speaker identity, Guildscribe keeps speaker-separated capture
intervals, and FFmpeg publishes a combined MP3.

The next slice may run a dedicated transcription hook over completed
participant audio. Its bundled default adapter submits local Granite Speech
work to Nightcrew while the host is away; an owner may substitute an executable
script. Guildscribe does not summarize, extract bullets, run reasoning prompts,
manage models, or run its own inference server.

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
  restart; and
- invokes optional local executable hooks for recording events.

The transcription worker, bundled Nightcrew adapter, speaker-track publication,
transcript merging, and result persistence are not implemented in this slice.

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
    uninstallLaunchAgent.sh
  src/
    index.ts
    cli.ts
    config.ts
    daemon.ts
    doctor.ts
    hooks.ts
    manifests.ts
    macosLaunchAgent.ts
    recorder.ts
    recordings.ts
    renderer.ts
    results.ts
    startup.ts
  test/
    config.test.mjs
    macosLaunchAgent.test.mjs
    manifests.test.mjs
    recorder.test.mjs
    recordings.test.mjs
    results.test.mjs
```

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
      intervals/
        <intervalID>.json
        <intervalID>.pcm
      audio.part.mp3
  recordings/
    <year>/
      <month>/
        <recordingID>/
          recording.json
          intervals/
            <intervalID>.json
            <intervalID>.pcm
          audio.mp3
```

`guildscribe.lock` exists only while the daemon is running. Completed raw PCM
files and their JSON interval sidecars remain permanently with the published
recording so speaker audio, identity, timing, and capture gaps stay inspectable
and available to optional processing.

The runtime home uses mode `0700` and `.env` uses mode `0600` on POSIX systems.
Runtime files never belong in the source checkout.

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

The two `HOOK_TRANSCRIPTION_*` names reserve lifecycle notifications for the
transcription slice and are not emitted yet. Lifecycle-hook values are absolute
executable paths. The default empty grace is 30 seconds and the default
lifecycle hook timeout is 30 seconds.

## Persistent documents

`recording.json` and every interval sidecar are versioned JSON documents.
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

Proposed: `GUILDSCRIBE_TRANSCRIPTION_HOOK` selects the worker that performs
transcription. An omitted value or `nightcrew` uses the bundled Nightcrew
adapter, `off` disables transcription, and an absolute executable path replaces
the adapter. This setting does not exist in the implemented configuration yet.
The transcription worker has its own durable lifecycle and is not subject to
the short lifecycle-hook timeout.

After a completed recording and its audio are durable, Guildscribe may enqueue
one transcription-hook invocation keyed by recording ID. The invocation runs
outside the Discord capture loop, so a slow or unavailable transcriber cannot
delay joining, recording, rendering, or publishing another meeting. Pending
work survives daemon restart, and the hook contract requires idempotent handling
of the recording ID.

The executable receives a versioned JSON request on stdin and the recording
directory as its working directory. The request identifies the recording,
combined audio, retained PCM intervals, speaker metadata, and staging paths for
the canonical transcript outputs. It does not contain the Discord token. The
exact request and result schemas will be fixed before this slice is implemented.

The bundled default executable is a thin Nightcrew adapter. It submits the
durable job, waits for Nightcrew's result through Nightcrew's public client
contract, and writes only to the provided staging paths. A custom absolute
executable implements the same contract and may use any local or remote
transcriber. On a successful, valid result Guildscribe atomically publishes
`transcript.json` and `transcript.txt`; on failure it retains the audio and
durable transcription state, including PCM intervals, for inspection or retry.
Successful transcript publication also leaves the PCM payloads unchanged.
Guildscribe does not create FLAC, WAV, or consolidated per-speaker tracks.

## CLI

Guildscribe follows dmbridge's agent-safe conventions:

```text
guildscribe help
guildscribe version
guildscribe init --request <file-or-dash> [--dry-run]
guildscribe doctor
guildscribe recordings list
guildscribe recordings show <recordingID>
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
--non-interactive
--quiet
--verbose
--verbosity <quiet|normal|verbose|debug>
```

Finite commands emit one protocol-version-1 JSON envelope on stdout. Errors
use stable codes, structured details, and retry-safety classifications.
Diagnostics use stderr. Secrets never appear in output.

### Recording inventory

`recordings list` discovers both published recordings and recoverable
directories under `in-progress`. It returns records ordered by descending
`startedAt` plus aggregate totals. Each record reports its storage class,
manifest lifecycle fields, combined-audio byte size, PCM file count and byte
size, total file count, and total bytes for the entire recording directory.

`recordings show <recordingID>` returns the same record shape for one exact
recording ID. Missing IDs fail with `recording_not_found`; an ID present in
more than one storage location fails with `recording_ambiguous`. These commands
only inspect filesystem metadata and never read or expose captured audio or
transcript contents.

### Initialization

`guildscribe init` reads a JSON request from a file or stdin:

```json
{
  "discordToken": "...",
  "voiceChannelIDs": ["...", "..."],
  "emptyGraceMs": 30000,
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

### Doctor

`guildscribe doctor` reports individual checks for:

1. runtime-home and `.env` existence and restrictive permissions;
2. valid configuration and writable artifact directories;
3. executable configured hooks;
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

## Transcription and Nightcrew boundary

The transcription slice will publish `transcript.json` as the canonical
versioned document and `transcript.txt` as a readable projection. Speaker is an
optional transcript-segment field so imported or otherwise unattributed audio
can still use the format.

For Discord recordings, Guildscribe passes the retained speaker-attributed PCM
intervals and their meeting-relative timing to the configured transcription
hook. The default hook submits a durable job to Nightcrew.
Nightcrew owns the shared llama.cpp router, the `granite.audio` inference lane,
model loading and unloading, request priority, and desktop-presence gating.
Unknown or unhealthy presence fails closed in Nightcrew; a returning user stops
Granite work at a recoverable chunk boundary.

Guildscribe remains the source of truth for recording identity, Discord speaker
metadata, transcript status, and published transcript files. Neither Nightcrew
nor a custom hook may publish directly over canonical files. The configured
hook returns structured text and timing results through the staging contract;
Guildscribe validates and promotes them atomically, then emits transcription
lifecycle hooks only after the corresponding state is durable.

The hook request schema, Nightcrew client transport, job-resumption contract,
and exact result schema remain to be specified before implementation.
Guildscribe must continue recording when Nightcrew or a custom hook is absent,
stopped, busy, or unhealthy; transcription stays pending, failed, or disabled
without invalidating the audio artifact.

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
- No SQLite database or runtime dependency is created.
