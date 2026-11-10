# Guildscribe

A self-hosted Discord meeting recorder with speaker identity, combined MP3 audio,
searchable local messages and transcripts, and optional transcription through an
executable hook. It records one allowed voice channel at a time and retains audio
independently of transcription.

**[Read the documentation](https://twocentinc.github.io/oss/docs/guildscribe/)**

- [Installation and setup](https://twocentinc.github.io/oss/docs/guildscribe/getting-started/)
- [Configuration](https://twocentinc.github.io/oss/docs/guildscribe/configuration/)
- [Recordings, recovery, and export](https://twocentinc.github.io/oss/docs/guildscribe/recordings/)
- [Local history and backups](https://twocentinc.github.io/oss/docs/guildscribe/history/)
- [Transcription](https://twocentinc.github.io/oss/docs/guildscribe/transcription/)
- [Lifecycle hooks](https://twocentinc.github.io/oss/docs/guildscribe/hooks/)
- [Messages and slash commands](https://twocentinc.github.io/oss/docs/guildscribe/messaging/)
- [Operations and security](https://twocentinc.github.io/oss/docs/guildscribe/operations/)
- [Generated CLI and schema reference](https://twocentinc.github.io/oss/docs/guildscribe/reference/)
- [Troubleshooting](https://twocentinc.github.io/oss/docs/guildscribe/troubleshooting/)
- [Development and distribution](https://twocentinc.github.io/oss/docs/guildscribe/contributing/)

Requires Node.js 22.12+, FFmpeg, and ffprobe. The npm package is not yet published;
installation currently requires source access or an owner-supplied artifact.

The [engineering specification](docs/spec.md) remains the canonical product and
architecture contract for contributors. The shared docs site owns user guides;
source and reviewed snapshots own runtime command and schema contracts.
