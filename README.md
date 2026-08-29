# pi-sand

A Linux-first desktop Agent product around the installed Pi CLI. The v0.1.0 product boundary keeps durable product state, the Local Agent Service, and the Desktop presentation separate:

```text
Desktop Client → Local Agent Service → pi --mode rpc → Agent workspace
```

## Launch the product

Requires Node.js 22.13+ (the service uses the unflagged built-in `node:sqlite` module), Chromium, and `pi` on `PATH`.

```sh
npm run launch
```

The supported Linux entry point starts or connects to the loopback-only Local Agent Service, then locates and invokes the supported Chromium Desktop directly. No terminal, manually selected port, or manually opened localhost URL is required for normal use. `PI_SAND_NO_BROWSER=1 npm run launch` starts the product service without opening a browser, which is useful for automated checks. Chromium must be installed and available at `/usr/bin/chromium`, `/usr/bin/chromium-browser`, or on `PATH`.

`npm start` remains a developer-oriented service-only entry point; it is not the normal product experience. The service binds only to `127.0.0.1`, protects mutation requests from unrelated browser origins, and allows only one Local Agent Service process to own a database at a time.

By default the SQLite database is stored at `${XDG_DATA_HOME:-~/.local/share}/pi-sand/pi-sand.sqlite`. Set `PI_SAND_DB` to choose another database, `PORT` to choose the fixed local endpoint, or `PI_BIN` to choose the Pi executable. The v0.1 production adapter supports Pi `0.84.2` exactly and preflights `PI_BIN --version` before the first Turn; an unavailable or incompatible Pi is reported as a product-level error. The service creates its database and parent directory on first start.

Create an Agent with a workspace directory, then submit ordinary natural-language requests. Workspace input accepts absolute paths and `~`/`~/...`; other relative paths are rejected. Accepted paths are verified directories, realpathed, and persisted as one canonical workspace identity, so symlink aliases share the same execution exclusion.

## Product boundary

The Local Agent Service owns durable Agents, Turns, user/assistant transcript messages, staged/committed attachment metadata, canonical workspaces, and Pi process ownership. The Desktop owns presentation state such as the selected Agent and unsent per-Agent drafts. Closing the Desktop does not stop the service or active Pi work; reopening takes an authoritative snapshot and reconnects to semantic updates without replaying or duplicating transcript messages.

Pi owns reasoning, tools, skills, retries inside its autonomous loop, and its native conversational context. pi-sand does not add a planner, scheduler, queue, worker pool, provider abstraction, replay loop, or custom memory/context system. Independent Agents may run concurrently only when their canonical workspaces differ. Stop, unexpected Pi exit, and service-restart reconciliation produce explicit durable Turn outcomes; unfinished work after service restart is interrupted without replay or worker adoption.

Process groups are best-effort cleanup, not complete containment: unrestricted Pi tools may create descendants outside the recorded PGID. After a Local Agent Service lifetime boundary in the same Linux boot, an unresolved real Pi worker keeps its workspace fail-closed and unavailable. A Linux reboot supplies the v0.1 complete process-lifetime proof through the kernel boot ID; pi-sand does not adopt, replay, or resume the old worker. Stronger cgroup-style containment is not part of v0.1.

## Test seams

The v0.1.0 release proof has exactly three durable seams:

1. **Actual Desktop E2E** — supported Chromium is rendered and driven through the product. These tests live in `test/desktop-actual-e2e.test.js`, `test/desktop-attachment-e2e.test.js`, `test/desktop-chromium-e2e.test.js`, `test/desktop-process-e2e.test.js`, and `test/product-boundary.test.js` (Chromium-dependent tests are skipped when the supported runtime is unavailable).
2. **Local Agent Service integration** — deterministic narrow Pi fakes prove persistence, lifecycle, reconnect, workspace safety, attachments, ownership, and control-plane behavior. `test/service.test.js`, `test/attachments.test.js`, `test/orphan-worker.test.js`, `test/product-boundary.test.js`, and `test/stop-isolation.test.js` contain this coverage. `test/service-http-e2e.test.js` proves HTTP/SSE transport only; it is not Actual Desktop E2E.
3. **Small Real-Pi smoke** — `test/real-pi.acceptance.test.js` contains the three production contracts: basic execution, two-Turn Pi-native conversational continuity, and production attachment consumption. It is skipped by the deterministic suite and requires `PI_SAND_REAL_PI=1` with a configured model.

The renamed `desktop-client-harness*.test.js` files are fake-DOM/client harness support tests, not Actual Desktop E2E. They remain useful for narrow rendering behavior but do not count as the compatibility authority.

Run the deterministic suite and Pi contract self-test with:

```sh
npm test
npm run spike:self-test
```

Run the opt-in production smoke layer with:

```sh
npm run test:real-pi
```

## Documentation authorities

- [`SPEC-v0.1.md`](SPEC-v0.1.md) is the sole normative v0.1.0 product specification.
- [`REFERENCE.md`](REFERENCE.md) is the explicitly non-normative Grok Bot 0.18 evidence ledger.
- [`docs/v0.1-lifecycle-evidence.md`](docs/v0.1-lifecycle-evidence.md) records current evidence classifications and pi-sand extensions.
- [`SPEC.md`](SPEC.md) is retained as superseded historical material and must not be used as a competing release authority.
