import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiCompatibility, SUPPORTED_PI_VERSIONS } from "../src/pi.js";

async function writeFakePi(directory, name, { stdout = "", stderr = "", exitCode = 0 } = {}) {
  const command = join(directory, name);
  await writeFile(command, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exit(${exitCode});`,
    "",
  ].join("\n"));
  await chmod(command, 0o755);
  return command;
}

test("the Pi compatibility gate accepts only explicitly verified versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-pi-compatibility-"));
  try {
    assert.deepEqual([...SUPPORTED_PI_VERSIONS], ["0.84.2", "0.84.4"]);
    const cases = [
      ["0.84.2", true],
      ["0.84.4", true],
      ["0.84.1", false],
      ["0.84.3", false],
      ["0.85.0", false],
    ];
    for (const [version, compatible] of cases) {
      const command = await writeFakePi(directory, `pi-${version.replaceAll(".", "-")}`, { stdout: `${version}\n` });
      const result = checkPiCompatibility({ command });
      assert.equal(result.version, version);
      assert.equal(result.compatible, compatible, `${version} compatibility result`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Pi compatibility gate rejects malformed and nonzero version probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sand-pi-compatibility-"));
  try {
    const malformed = await writeFakePi(directory, "pi-malformed", { stdout: "Pi 0.84.4\n" });
    assert.deepEqual(checkPiCompatibility({ command: malformed }), { compatible: false, version: null, error: null });

    const nonzero = await writeFakePi(directory, "pi-nonzero", { stdout: "0.84.4\n", exitCode: 1 });
    const result = checkPiCompatibility({ command: nonzero });
    assert.equal(result.compatible, false);
    assert.equal(result.version, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Pi compatibility gate rejects an unavailable executable", () => {
  const result = checkPiCompatibility({ command: "/path/that/does/not/exist/pi" });
  assert.equal(result.compatible, false);
  assert.equal(result.version, null);
  assert.equal(result.error?.code, "ENOENT");
});
