# pi-sand

`pi-sand` is a Pi package for handing one coding job to a durable local runtime. Give it an objective, leave Pi, and `pi-sandd` keeps responsibility until the requested evidence is complete, the job is legitimately blocked, cancelled, or a bounded repair budget is exhausted.

```text
Pi Manager
  └─ pi-sand Extension: /task, /tasks, /task-show, /task-stop, /task-retry
       └─ protocol-v2 Unix socket
            └─ pi-sandd
                 └─ isolated Git worktree + dedicated task branch
                      └─ Fresh Pi 0.84.4 executor
```

## v0.4 user contract

A coding job may follow this lifecycle:

```text
accept one job
→ execute in an isolated task worktree
→ checkpoint an exact candidate revision
→ run explicit deterministic local gates
→ optionally publish the exact revision to an authorized dedicated branch
→ wait for exact-SHA GitHub CI without holding Pi open
→ reconcile after daemon/Manager downtime
→ perform bounded repair when CI fails
→ keep a durable Result for the next Manager to claim
```

The normal workflow remains user-facing and Task-oriented:

```sh
pi install /absolute/path/to/pi-sand
pi
/task Implement the requested change, run its tests, and wait for CI.
```

The Extension is a client. The Manager's lifetime is not the Task's lifetime: quitting, reloading, `/new`, `/resume`, `/fork`, closing the TUI, or losing IPC does not cancel accepted work. A later Manager can inspect the Task and claim its Result.

For integration and automation callers, protocol-v2 `task.create` accepts an explicit bounded `completionContract`, including local gate commands, typed CI selectors, authority, and budget. The ordinary `/task <goal>` form remains credential-free and does not invent verification or remote-write authority. The Extension also accepts a JSON object containing these explicit fields when a caller needs to pass a completion contract through the public task command seam.

## Boundaries

v0.4 intentionally remains small:

- there is one unresolved autonomous Coding Commitment globally; a waiting job releases the Pi executor but not this Commitment slot;
- remote publication requires explicit persisted authority and is limited to `refs/heads/pi-sand/<task-id>`;
- publication is exact-CAS/readback and fast-forward-only after the first revision;
- pi-sand never creates pull requests, merges, rebases, cherry-picks, rewrites, or deletes remote history;
- CI truth is reconciled deterministically by the runtime for the exact repository, typed selectors, and exact revision SHA; it is not LLM polling;
- local/CI repair is finite and budgeted; model prose cannot override a failed hard gate;
- completion writes a durable local Result independently of Manager availability;
- Result presentation is reconnectable at-least-once: render happens before acknowledgement, so a Manager crash may show the same stable Result again;
- v0.4 has no scheduler, queue, multi-worker pool, browser/computer use, cloud runtime, persistent foreground transcript, Knowledge/Wiki, or learning/Skill evolution.

A local daemon cannot run while the whole machine is powered off. The runtime is Linux-only and Fresh Executors require Pi **0.84.4** exactly.

## Release proof

The default suite is offline, deterministic, and credential-free:

```sh
npm test
npm run spike:self-test
npm run test:v0.4-release
```

`test/v0.4-release.integration.test.js` is the release-level public-seam proof. It starts a real `pi-sandd` process, drives protocol-v2 through the Extension/RuntimeClient seams, uses a temporary Git source/worktree and local bare remote, runs a deterministic fake Pi executable, and serves deterministic fake GitHub Checks/status API responses. It proves green leave-and-return completion and one failed exact-SHA revision followed by a fresh repair Attempt, exact-R2 publication/wait, restart reconciliation, capacity refusal, and durable Result claim/ack.

Focused predecessor suites remain the detailed safety evidence:

- `test/v0.4-commitment.integration.test.js` — Task-backed Commitment and settlement boundary;
- `test/v0.4-bounded-repair.integration.test.js` — finite local/CI repair budgets;
- `test/v0.4-remote-publication.integration.test.js` — exact-CAS publication and ambiguity handling;
- `test/v0.4-ci-wait.integration.test.js` and `test/v0.4-ci-reconciliation.integration.test.js` — exact waits and deterministic observation;
- `test/v0.4-wake-continuation.integration.test.js` — atomic wake, duplicate, stale, and crash histories;
- `test/v0.4-control-fencing.integration.test.js` — cancel/correction fences;
- `test/v0.4-result.integration.test.js` and `test/v0.4-result.extension.test.js` — durable Result claim/ack and render-before-ack;
- `test/v0.4-semantic-review.integration.test.js` — conditional fresh reviewer only when the contract requests it;
- `test/v0.4-reprompt.integration.test.js` — acknowledged same-Attempt Pi re-prompt.

## Opt-in real-host proofs

These commands are skipped clearly unless explicitly enabled/configured; they are not part of `npm test`.

### Real Pi 0.84.4 Manager proof

```sh
npm run test:real-runtime
```

Set `PI_SAND_REAL_RUNTIME=1`, install Pi 0.84.4, and provide usable selected-provider credentials. This preserves the historical real Manager A → Extension → `pi-sandd` → Fresh Executor process boundary while supplying an explicit deterministic local gate through the public task command seam. Manager A exits before verification completes; Manager B later inspects the same verified Task. It does not restore `agent_settled` as completion authority.

The historical Local Agent Service smoke remains separate:

```sh
npm run test:real-pi
```

### Real GitHub exact-SHA proof

```sh
npm run test:real-github
```

Configure all of these before enabling it:

```text
PI_SAND_REAL_GITHUB_SOURCE       clean local checkout with an origin remote
PI_SAND_REAL_GITHUB_REMOTE       explicit authorized origin URL (documented configuration)
PI_SAND_REAL_GITHUB_REPOSITORY   owner/name
PI_SAND_REAL_GITHUB_CHECK        typed selector(s), comma-separated
PI_SAND_REAL_GITHUB_HOST         optional host, default github.com
```

The test uses a deterministic fake Pi to produce the candidate and the real GitHub API/remote to publish and observe it. The configured workflow must run on `pi-sand/<task-id>` without a PR. Set `PI_SAND_REAL_GITHUB_PR_ONLY=1` for a configured PR-only repository; the command reports that configuration as unsupported and never creates a PR. Credentials are read from the user's normal Git/GitHub configuration and are never serialized into Task, IPC, Evidence, or logs.

## Package and host

The package manifest exposes `./extensions/pi-sand.ts` through `pi.extensions`; no build step is required for the TypeScript Extension loader. Install a local checkout with `pi install /absolute/path/to/pi-sand` or load it during development with `pi -e /absolute/path/to/pi-sand`.

The public runtime methods are `runtime.status`, `task.create`, `task.list`, `task.get`, `task.stop`, `task.correct`, `task.retry`, `result.claim`, and `result.ack`. IPC is newline-delimited JSON over an owner-only Unix socket. Protocol mismatches fail clearly; mutating disconnects are not blindly replayed.

`task.get` is authoritative for terminal Task truth. Result delivery is separate from work completion: a Task may be completed while its Result is pending, claimed, or acknowledged.

## Historical evidence

The repository retains the v0.1 Desktop/Local Agent Service and v0.2 host tests as historical implementation evidence. They remain covered by the default suite and are not the v0.4 runtime architecture. `SPEC-v0.1.md`, `REFERENCE.md`, and `docs/v0.1-lifecycle-evidence.md` describe that historical product path.

The architecture authority for the leave-and-return Coding Commitment is GitHub issue [#48](https://github.com/TimCole666/pi-sand/issues/48); the v0.4 implementation map and release convergence contract are in issue [#61](https://github.com/TimCole666/pi-sand/issues/61).
