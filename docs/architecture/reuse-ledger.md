# Reuse ledger

- **Research snapshot:** 2026-09-01
- **Role:** advisory implementation evidence below `docs/adr/0001-reuse-first-runtime-boundary.md`
- **Rule:** revalidate version, API, maintenance, license, security, operational fit, and current Pi compatibility immediately before adoption

This file records where future specs should look before writing commodity mechanics. It is deliberately easier to revise than an ADR. Exact technologies listed here are candidates, not permanent architecture commitments.

## Reuse modes

- **DIRECT** — stable package/API dependency candidate.
- **CLI** — existing executable behind a narrow adapter.
- **PORT** — copy/translate one small licensed module with tests, attribution, exact source revision, and modification record.
- **DESIGN** — reproduce a technical design without importing the host runtime.
- **ARCHITECTURE** — clean-room architecture/product lesson only.
- **REJECT** — do not import for the stated purpose.

## Donor matrix

| Capability | Source | Mode | Candidate use | Boundary / caveat |
|---|---|---|---|---|
| Agent/model/tool loop | Pi package family | DIRECT | Agent Engine | Pi Session remains below Commitment |
| Context/compaction | Pi ResourceLoader/Session | DIRECT | ordinary project resources, prompts, context windows, compaction | pi-sand owns durable fact selection/receipt only |
| Skills | Pi Skills/ResourceLoader | DIRECT | representation, discovery, loading | pi-sand owns evaluation/promotion authority |
| Isolated workers | Pi official subagent example | PORT / DESIGN | fresh subprocess workers, bounded aggregation | example lifecycle is not durable authority |
| Permission/trust/protected paths | Pi official Extensions/examples | DESIGN | foreground interception/capability-admission patterns | durable HumanGate remains pi-sand state |
| SSH/tool substitution | Pi official SSH example | DESIGN | remote backend/tool shape | Environment owns durable remote identity |
| VM-backed tools | Gondolin + official Pi example | DIRECT / DESIGN | optional strict Environment backend | qualify platform/runtime/security fit before adoption |
| Channel adapters | `earendil-works/pi-chat` | PORT | Discord/Telegram mechanics if needed | old Pi namespace; Conversation must not become lifetime root |
| Attachment staging | `pi-chat` | PORT | safe host/guest materialization and containment | Apache-2.0 notice/attribution if code is ported |
| Secret-request mechanics | `pi-chat` | DESIGN | opaque secret request/redaction UX | pi-sand owns durable scope/audit/gate semantics |
| Catch-up-before-live | `pi-chat` | DESIGN | reconnect/channel sequencing | catch up authoritative history before arming live events |
| FTS/trigram recovery | Hermes Agent | DESIGN / small PORT | search health, CJK fallback, rebuildable index | Hermes Session schema is not pi-sand Knowledge |
| Due/cron claim/catch-up/grace | Hermes Agent | DESIGN / small PORT | narrow v0.7 wake mechanics | keep authoritative state in pi-sand SQLite |
| Environment-provider shape | Hermes Agent | DESIGN | backend-neutral probe/create/inspect/exec/materialize/reconcile | do not embed Hermes Python runtime |
| Delivery separation | Hermes Agent | ARCHITECTURE | target/receipt separation | Hermes Gateway is not Commitment root |
| Skill-learning loop | Hermes Agent | ARCHITECTURE | candidate -> evaluate -> gate -> promote -> rollback | Pi loads approved Skills |
| Remote WebSocket client | OpenClaw public gateway client | DIRECT, future | remote/web/mobile reconnect mechanics | transport candidate only; OpenClaw domain must not leak upward |
| Remote frame validation | OpenClaw public gateway protocol | DIRECT, future | future remote transport validation | not pi-sand durable domain schema |
| Sandbox backend interfaces | OpenClaw internal sandbox modules | DESIGN | exec/fs handles, lifecycle, generation fencing | internal APIs are not stable public dependencies |
| SSH fs/exec bridge | OpenClaw internal sandbox code | PORT if needed | remote Environment bridge | strip host coupling and retain MIT attribution |
| DB doctor/migration discipline | OpenClaw state DB | DESIGN | schema fence, integrity checks, quarantine, rebuild | retain one pi-sand authority DB until concrete pressure says otherwise |
| Search/index maintenance | OpenClaw memory code | DESIGN / small PORT | derived FTS/trigram/vector maintenance | canonical Knowledge remains pi-sand-owned |
| Capability/runtime fingerprint | OpenClaw harness design | ARCHITECTURE | admitted-run/continuation fencing | do not import OpenClaw Agent Engine/harness |
| Persistent Computer | Grok Bot/Sand reconstruction | ARCHITECTURE ONLY | product model for retained Environment/Computer | reconstructed source is not a code donor |
| Explicit user-visible communication | Grok Bot/Sand reconstruction | ARCHITECTURE ONLY | separate worker output from Message/Question/Approval/Result/Artifact | clean-room pattern only |
| Human gate/takeover/wake identity | Grok Bot/Sand reconstruction | ARCHITECTURE ONLY | typed gates, manual takeover, wake reason | clean-room pattern only |
| Browser mechanics | Playwright | DIRECT | navigation/actions/downloads/screenshots/traces/profiles | Environment/Artifact/Evidence semantics remain pi-sand |
| Git mechanics | native `git` CLI | CLI | worktrees, refs, exact lease/CAS push, readback | pi-sand owns exact identity/authority |
| GitHub transport | `gh api` or Octokit | CLI / DIRECT | auth/endpoints/pagination/rate-limit/error mechanics | choose one through a post-v0.4 spike; exact SHA/selectors/Evidence remain pi-sand |
| Authority DB | Node `node:sqlite` + SQLite | DIRECT | durable state and explicit transactions | avoid obscuring correctness-critical transactions with a heavy ORM |
| General Environment | host or Docker candidate | native / CLI | initial browser/general execution backend | v0.5 spec should select the smallest operationally credible first backend |
| Strict local isolation | Gondolin | DIRECT | optional micro-VM backend | experimental/platform constraints; not a default without qualification |
| Managed policy sandbox | OpenShell | CLI, later | optional policy-rich backend | operational burden must be justified |
| Remote Environment | OpenSSH | CLI / narrow library | user-owned remote computers | record host key/target/backend identity |
| Recurrence grammar | `cron-parser` | DIRECT | timezone/DST/next-occurrence parsing | parser only; pi-sand owns due/wake state |
| Optional vector index | `sqlite-vec` | DIRECT, later | derived similarity index | add only after measured FTS gap; never sole authority |

## Explicit rejects

These are current non-candidates. Do not adopt them without a concrete release requirement and evidence that the reuse-first ownership boundary remains intact:

- Hermes Agent Engine/provider/context runtime;
- OpenClaw Agent Engine/harness/plugin host;
- OpenClaw Gateway as the responsibility root;
- pi-chat job-log authority, tmux/PID worker lifecycle, or custom Skills loader;
- arbitrary ambient Pi Extensions inside coding Fresh Executors;
- Temporal, BullMQ/Redis, LangGraph, AutoGen, CrewAI, or another general workflow/multi-agent runtime for the local roadmap;
- a heavy ORM around correctness-critical SQLite transitions;
- custom Git/browser/container/VM implementations;
- Grok Bot/Sand reconstructed implementation code.

The ADR independently prohibits adding a second Agent Engine beside Pi. The provenance rules below independently prohibit treating reconstructed Grok Bot/Sand source as an implementation donor without a valid rights basis. Other items in this list remain revisable when concrete release evidence justifies reconsideration.

## License and provenance discipline

When copying, porting, or vendoring code:

1. record canonical repository, exact revision, and source path;
2. verify the license that actually covers the file/module;
3. retain required copyright/license/NOTICE material;
4. record modifications;
5. keep a replacement/removal path.

Do not infer that a repository root license grants rights to every generated, bundled, downloaded, preserved, or reconstructed artifact.

Grok Bot/Sand reconstructed material remains architecture/product evidence only unless independent rights review establishes otherwise.

## Research coordinates

The 2026-09-01 source audit inspected these coordinates. They are evidence snapshots, not dependency pins:

| Project | Snapshot / observed status |
|---|---|
| `TimCole666/pi-sand` | `main` `1caed4014b3552d0d12791489122daef7dfaceff`; v0.4 PR #62 was in progress |
| `earendil-works/pi` | `64921447734ef7a7e8ffcf3a72e076403ce48fa5`; package family observed at `0.84.4` |
| `earendil-works/pi-chat` | `9adbd29b40ee27ff1decf0fc87cbe180b40924f5`; Apache-2.0; old Pi namespace observed |
| `earendil-works/gondolin` | `29fa74d802112f29c720990aced26165e0d57d84`; Apache-2.0; package observed at `0.12.0` |
| `NousResearch/Hermes-Agent` | `71a82401706213f27799300096753733be7b7f41`; MIT |
| `openclaw/openclaw` | `8c577fe4c43456f957a20c40748b87d8c3fb38bb`; MIT |
| `b-nnett/grok-bot-0.18-reconstructed` | `a9f633e09d49a85829b8236331b9e21f7e612634`; architecture-only rights posture |

Before adoption, inspect the current canonical source rather than copying versions from this table.
