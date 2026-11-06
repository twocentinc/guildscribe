# AGENTS.md

This repository is the standalone Guildscribe project. Keep it independent of
Saratonin so it can be published and installed on its own.

## Product contract

- Treat `docs/spec.md` as the canonical product and architecture specification.
- Update the specification whenever a change moves a product boundary, runtime
  ownership boundary, persistent format, or source of truth.
- Keep `README.md` concise and public-facing; do not duplicate the full
  specification there.

## Scope

- Guildscribe is a Discord meeting recorder with optional local transcription
  supplied through one dedicated executable hook. Nightcrew integration, when
  desired, belongs in an external hook adapter rather than Guildscribe.
- FFmpeg owns media encoding and validation inside Guildscribe.
- Guildscribe assumes `ffmpeg` and `ffprobe` are already installed.
- Guildscribe must not install models, manage model servers, summarize
  transcripts, run reasoning prompts, or implement arbitrary processing
  pipelines.
- Keep signed 16-bit, 48 kHz stereo PCM intervals as the sole
  speaker-separated processing input. Do not add FLAC, WAV, or per-speaker
  track generation to canonical recordings. A user-requested portable export
  may include a derived WAV without changing its source.
- Nightcrew owns llama.cpp routing, model residency, inference scheduling, and
  desktop-presence policy. Guildscribe owns its recording and transcript
  artifacts and must remain usable for capture when Nightcrew is absent.

## Persistence

- Use `~/.guildscribe/.env` by default for configuration.
- Store recording state and artifacts as ordinary files below
  `~/.guildscribe`; do not add a database without a new concrete requirement.
- Write JSON manifests and interval sidecars atomically.
- Keep source files and runtime data separate. Never write runtime files into
  the repository checkout.
- Keep the configuration file and runtime home owner-only because `.env`
  contains the Discord token.

## CLI conventions

- Use dmbridge as the command-line design reference without copying its
  provider-specific concepts.
- Organize commands as `guildscribe <resource> <action> [flags]` where a
  resource/action form is natural.
- Emit one stable, versioned JSON result envelope on stdout for finite
  commands. Write progress, warnings, and diagnostics only to stderr.
- Support `--pretty`, `--request-id`, `--home`, `--timeout`,
  `--non-interactive`, and explicit verbosity controls consistently.
- Read secrets and structured mutation requests from a file or stdin, never
  from a plaintext command-line flag.
- Provide `--dry-run` for mutations when meaningful and require explicit
  confirmation for destructive commands.
- Keep commands safe for agents: stable field names, documented exit behavior,
  redacted secrets, and no prose mixed into JSON output.
- `guildscribe init` must require the Discord token and at least one voice
  channel ID, create `.env` exclusively, and fail rather than overwrite
  existing configuration.
- Treat configured voice channels as an allowlist with one global active
  recording. Never join or record more than one channel at a time.
- `guildscribe doctor` must verify FFmpeg, ffprobe, filesystem health, Discord
  token authentication, channel existence, and required bot permissions.
- Keep recording verification read-only. Exports must target a new location,
  include checksums, exclude transient staging data, and leave their source
  unchanged.

## Event hooks

- Hook configuration lives in `.env` as absolute executable paths.
- Emit `channel.joined` only after a new voice connection becomes ready and
  `channel.left` only after an announced connection is actually destroyed.
  Do not duplicate these events for transient reconnect state changes.
- Execute hooks directly without shell interpolation.
- Pass a versioned JSON event on stdin and never expose the Discord token in a
  hook environment or payload.
- Persist the corresponding recording state before invoking a hook.
- Hook failure must not roll back or invalidate a recording.

## Background behavior

- On macOS, keep LaunchAgent mechanics in the reusable
  `src/macosLaunchAgent.ts` module. Keep the Guildscribe label, paths, and
  daemon command in `src/startup.ts`, and all Discord behavior behind
  `guildscribe daemon run`.
- `guildscribe startup` owns per-user LaunchAgent management. Never require
  root, put credentials in a plist, or delete runtime data during uninstall.
- Store daemon and launchd logs below the selected Guildscribe runtime home.
- Recording must not depend on transcription availability.
- Keep the transcription hook separate from best-effort lifecycle event hooks.
  Run it outside the capture loop only after completed audio is durable, and
  retain enough state to recover pending work after restart.
- Retain interval PCM permanently with the completed recording, regardless of
  whether transcription is enabled or succeeds. Rendering and processing must
  never delete captured PCM.
- Preserve interrupted capture data and recover it into a playable recording
  when possible after restart.
- Run at most one transcription hook at a time. Resume durable pending or
  interrupted work after restart, but do not automatically retry a durable
  failed result.
- Guildscribe must not implement a second desktop-presence sampler or local
  model scheduler. Nightcrew fails closed on unknown or unhealthy presence
  before starting Granite work.
- Background failures must remain inspectable through manifests and must not
  delete completed recording artifacts.

## Distribution

- Package the compiled CLI, documentation, and operational scripts; never
  package runtime data or credentials.
- Verify the actual packed artifact through an isolated install before release.
- Release artifacts must include a SHA-256 checksum and build-provenance
  attestation.
- Upgrade and uninstall workflows must reject root execution and preserve the
  selected Guildscribe runtime home.

## Documentation

- Repository documentation must be plain-text Markdown.
- Do not add plans, architecture documents, or inventories that compete with
  `docs/spec.md`.
