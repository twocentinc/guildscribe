import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureDiagnosticFile, diagnostic } from "../dist/protocol.js";

test("daemon diagnostics rotate within the runtime log directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-logs-"));
  const log = path.join(root, "daemon.jsonl");
  try {
    configureDiagnosticFile(log, { maxBytes: 100, retainedFiles: 2 });
    diagnostic("info", "test.first", { payload: "x".repeat(100) });
    diagnostic("info", "test.second", { payload: "y".repeat(100) });
    assert.ok((await stat(log)).size > 0);
    assert.ok((await stat(`${log}.1`)).size > 0);
    assert.match(await readFile(log, "utf8"), /test\.second/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
