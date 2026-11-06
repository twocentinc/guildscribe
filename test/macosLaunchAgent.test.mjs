import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MacOSLaunchAgent,
  parseLaunchctlPrint,
  renderLaunchAgentPlist,
} from "../dist/macosLaunchAgent.js";

test("LaunchAgent plist keeps process supervision generic and escapes paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-plist-"));
  const plistPath = path.join(root, "agent.plist");
  try {
    const rendered = renderLaunchAgentPlist({
      label: "dev.guildscribe.test",
      plistPath,
      programArguments: ["/bin/bash", "/tmp/one & two/daemon", "/tmp/home"],
      workingDirectory: "/tmp/one & two",
      standardOutPath: "/tmp/out.log",
      standardErrorPath: "/tmp/error.log",
    });
    assert.match(rendered, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(rendered, /<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.match(
      rendered,
      /<key>ProcessType<\/key>\s*<string>Standard<\/string>/,
    );
    assert.match(rendered, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
    assert.match(rendered, /one &amp; two/);
    assert.doesNotMatch(rendered, /discord|token/i);

    await writeFile(plistPath, rendered, "utf8");
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], {
        encoding: "utf8",
      });
      assert.equal(lint.status, 0, lint.stderr || lint.stdout);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchctl print output becomes stable startup status", () => {
  const status = parseLaunchctlPrint(
    "dev.guildscribe.test",
    "/tmp/test.plist",
    `gui/501/dev.guildscribe.test = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 7\n}`,
  );
  assert.deepEqual(status, {
    label: "dev.guildscribe.test",
    plistPath: "/tmp/test.plist",
    configured: true,
    loaded: true,
    running: true,
    state: "running",
    pid: 4242,
    lastExitStatus: 7,
  });
});

test("LaunchAgent installation writes atomically and uses the user launchd domain", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-install-"));
  const plistPath = path.join(root, "Library", "LaunchAgents", "test.plist");
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args[0] === "print") {
      return { exitCode: 0, stdout: "state = running\npid = 99\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    const manager = new MacOSLaunchAgent(
      {
        label: "dev.guildscribe.test",
        plistPath,
        programArguments: ["/bin/true"],
        standardOutPath: path.join(root, "stdout.log"),
        standardErrorPath: path.join(root, "stderr.log"),
      },
      runner,
    );
    const status = await manager.install();
    assert.equal(status.running, true);
    assert.match(await readFile(plistPath, "utf8"), /dev\.guildscribe\.test/);
    assert.deepEqual(
      calls.map((call) => call[1]),
      ["bootout", "bootstrap", "enable", "print"],
    );
    assert.ok(calls[1].includes(`gui/${process.getuid()}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
