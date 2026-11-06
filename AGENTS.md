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
- Treat `src/commands.ts` as the canonical public command catalog and
  `src/protocol.ts` as the canonical owner of JSON schemas, envelopes, error
  semantics, exit classes, and contract versions. Do not maintain competing
  command or schema inventories in documentation.
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

## Reusable JSON-first CLI policy

Apply this section to future agent-operated CLIs unless the project has a
specific reason to narrow it. Keep project-specific product rules outside this
section so it can be copied without carrying Guildscribe behavior with it.

- Every finite command writes exactly one versioned JSON envelope to stdout.
  Diagnostics go to stderr and never corrupt stdout JSON.
- Include a caller-supplied request ID when present and generate one otherwise.
  Use stable command context in success and error envelopes.
- Publish retry safety as exactly `safe`, `unsafe`, or `never`. `safe`
  means automatic repetition cannot duplicate or compound an effect;
  `unsafe` means the outcome may be ambiguous; `never` means the caller must
  change input or state before retrying.
- Reserve stable exit classes for success, internal failures, invalid input,
  configuration, unsupported operations, external dependencies, timeouts,
  missing resources, and missing confirmation. Do not derive automation from
  human error prose.
- Version envelopes and schemas independently. A released schema version is
  immutable; incompatible contract changes require the schema version to move.
- Canonicalize object keys and deterministic collection ordering anywhere
  agents compare, cache, sign, or snapshot output.
- Read credentials and structured mutation requests from JSON files or stdin,
  never plaintext flags. Request parsers must reject unknown fields.
- Every meaningful mutation supports `--dry-run`. Non-interactive mode
  disables prompts but never grants authorization or confirmation.
- Idempotent mutations report whether state changed. Destructive commands
  require an explicit confirmation mechanism even in non-interactive mode.
- Duration flags require explicit units such as `ms`, `s`, or `m`; do not
  accept ambiguous bare numbers.
- Global flags are behavior, not decoration. `--pretty`, `--request-id`,
  `--timeout`, `--no-input`, `--quiet`, `--verbose`, and
  `--verbosity` must either work consistently or not be advertised.
- Help and contract discovery must be JSON-native. The runtime command registry
  and exported schemas are authoritative; Markdown examples are illustrative.
- Snapshot the public command catalog and exported JSON schemas. Intentional
  contract changes update snapshots in the same reviewed change.
- Keep CI read-only with minimum permissions on pushes and pull requests.
  Grant release write, identity-token, and attestation permissions only to the
  final publish job after verification succeeds.
- Test the actual packed artifact, inspect its allowlist and exclusions, install
  it with lifecycle scripts disabled, and smoke-test its executable and JSON
  discovery surfaces.
- Derive the displayed CLI version from the package manifest or release source
  of truth. Never duplicate a hardcoded runtime version.
- Enforce credential-file ownership, regular-file type, non-symlink status, and
  owner-only permissions when loading secrets, not only in a diagnostic command.

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
- Run ordinary push and pull-request CI with read-only repository permissions.
  Keep elevated release permissions isolated to the publish job.
- Upgrade and uninstall workflows must reject root execution and preserve the
  selected Guildscribe runtime home.

## Versioning and verification

- `package.json` is the version source of truth; keep the root
  `package-lock.json` versions synchronized.
- Bump the version for every owner-requested repository change: patch for
  compatible fixes, minor for backward-compatible capabilities, and major only
  for intentional breaking changes.
- Run `npm run check`, `npm test`, and `npm run test:package` before final
  handoff. Run `npm run contracts:update` only for an intentional reviewed
  command or schema contract change.

## Documentation

- Repository documentation must be plain-text Markdown.
- Do not add plans, architecture documents, or inventories that compete with
  `docs/spec.md`.
