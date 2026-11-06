#!/usr/bin/env node

import { runCLI } from "./cli.js";
import { GuildscribeError, sanitizeError } from "./protocol.js";

void runCLI().catch((error: unknown) => {
  const failure =
    error instanceof GuildscribeError
      ? error
      : new GuildscribeError("internal_error", sanitizeError(error), {
          cause: error,
          retrySafety: "unsafe",
        });
  process.stderr.write(
    `${JSON.stringify({
      event: "cli.unhandledFailure",
      level: "error",
      code: failure.code,
      message: failure.message,
      time: new Date().toISOString(),
    })}\n`,
  );
  process.exitCode = failure.exitCode;
});
