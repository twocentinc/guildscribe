# Guildscribe

Guildscribe records Discord meetings and captures Discord channel messages for
agents to search through a JSON CLI. It saves combined MP3 audio, speaker
identity, and searchable messages in your local runtime home.

It records one allowed voice channel at a time. Recording works without a model
or transcription service. To generate searchable transcripts, connect your own
executable hook. Audio is retained even when transcription fails.

Requires Node.js 22.12+, FFmpeg, and ffprobe. Follow the setup guide to build from
a checkout or install a package archive. Capture runs on macOS and
Linux, with built-in service management for macOS LaunchAgents.

**[Read the documentation](https://oss.twocents.com/docs/guildscribe/)**

- [Installation and setup](https://oss.twocents.com/docs/guildscribe/getting-started/)
- [Configuration](https://oss.twocents.com/docs/guildscribe/configuration/)
- [Files, formats, and storage](https://oss.twocents.com/docs/guildscribe/files/)
- [Recordings, recovery, and export](https://oss.twocents.com/docs/guildscribe/recordings/)
- [Local history and backups](https://oss.twocents.com/docs/guildscribe/history/)
- [Transcription](https://oss.twocents.com/docs/guildscribe/transcription/)
- [Lifecycle hooks](https://oss.twocents.com/docs/guildscribe/hooks/)
- [Messages and slash commands](https://oss.twocents.com/docs/guildscribe/messaging/)
- [Operations and security](https://oss.twocents.com/docs/guildscribe/operations/)
- [Command Map](https://oss.twocents.com/docs/guildscribe/command-map/)
- [CLI and schema reference](https://oss.twocents.com/docs/guildscribe/reference/)
- [Troubleshooting](https://oss.twocents.com/docs/guildscribe/troubleshooting/)
- [Development and distribution](https://oss.twocents.com/docs/guildscribe/contributing/)

[MIT license](LICENSE)
