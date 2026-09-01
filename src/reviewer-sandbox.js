import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const MOUNT = "/usr/bin/mount";
const SETPRIV = "/usr/bin/setpriv";

function usage() {
  throw new Error("Reviewer sandbox requires view, task worktree, source repository, command, and JSON arguments.");
}

function pathArgument(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) usage();
  return realpathSync.native(value);
}

function mountReadOnlyFrom(source, path) {
  let result = spawnSync(MOUNT, ["--bind", source, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`bind mount failed for ${path}: ${String(result.stderr ?? "").trim()}`);
  result = spawnSync(MOUNT, ["-o", "remount,bind,ro", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`read-only remount failed for ${path}: ${String(result.stderr ?? "").trim()}`);
}

function mountReadOnly(path) {
  mountReadOnlyFrom(path, path);
}

function sourceGitConfig(sourceRepoRoot) {
  const gitPath = join(sourceRepoRoot, ".git");
  try {
    if (lstatSync(gitPath).isDirectory()) return join(gitPath, "config");
    const match = readFileSync(gitPath, "utf8").match(/^gitdir: (.+)$/m);
    return match ? join(resolve(dirname(gitPath), match[1].trim()), "config") : null;
  } catch {
    return null;
  }
}

function main() {
  const [view, taskWorktree, sourceRepoRoot, command, encodedArguments] = process.argv.slice(2);
  if (!encodedArguments || typeof command !== "string" || command.length === 0) usage();
  let argumentsForCommand;
  try {
    argumentsForCommand = JSON.parse(encodedArguments);
  } catch {
    usage();
  }
  if (!Array.isArray(argumentsForCommand) || argumentsForCommand.some((value) => typeof value !== "string")) usage();

  const paths = [...new Set([
    pathArgument(view),
    pathArgument(taskWorktree),
    pathArgument(sourceRepoRoot),
  ])];
  for (const path of paths) mountReadOnly(path);

  // Hide the shared repository config inside this namespace. The reviewer can
  // inspect objects and diffs, but even an attempted `git push` has no named
  // remote. The real config remains untouched outside the private namespace.
  const config = sourceGitConfig(pathArgument(sourceRepoRoot));
  if (config && existsSync(config)) mountReadOnlyFrom("/dev/null", config);

  const result = spawnSync(
    SETPRIV,
    ["--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--", command, ...argumentsForCommand],
    { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
}
