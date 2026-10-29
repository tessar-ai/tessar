# Agent registration: evidence and API decision

Date: 2026-10-19

Status: historical technical assessment. The subagents proposal was withdrawn.

## Decision (superseded)

The user withdrew the proposed Controller subagents option. Implement only
live-instance ID checks and tessar.agent.register(agent). Delegation remains
plugin-owned. See 2026-10-20-tessar-agent-registration.md for the implemented scope.

The alternatives below are historical analysis, not an implementation plan.

## Alternatives and actual cost

| Constructor shape | Default selection | Effect on existing code | Internal dispatch |
| --- | --- | --- | --- |
| `agent: [assistant, planner]` | Requires an extra rule or explicit selector | Changes the meaning/type of an existing option | Must still resolve a target and build its execution environment |
| `agent: assistant, agents: [planner]` | Existing Agent remains default | Additive | Same work as `subagents`; the difference is public API meaning |
| `agent: assistant, subagents: [planner]` | Existing Agent remains default | Additive | Same target lookup and isolation requirements |

No runtime benchmark establishes that spelling a field `subagents` makes
execution faster. The reason to prefer it here is an explicit default, additive
configuration, and direct correspondence with the expected delegation use case.

## Evidence from the current checkout

Inspected revision: `312e659` on `dev`.

- Controller requires one Agent and attaches that instance in its constructor.
- Session assigns `this.agent = controller.agent`.
- Thread input, resume and recovery route through `controller.agent.admit()`.
- Controller installs that Agent's declared tools into the shared PluginHost.
- The loop obtains tool descriptions from its captured registry.
- `reserveChild` persists a thread/stream reservation and origin, but does not
  record or resolve a different Agent target.
- Existing child-execution tests use the same harness Agent to run both streams;
  they do not prove that two differently configured Agents can share a runtime.

The reusable registry machinery already rejects duplicate `(kind, id)` entries
across initial values and plugin registrations. A typed Agent capability can use
that mechanism; a separate global Agent registry is not necessary for ID checks.
The default Agent must participate in that same namespace for its ID to be
protected from plugin collisions.

## Executed runtime probe

Reproduction: `.superpowers/probes/agent-registration.mjs`.

```powershell
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node .superpowers/probes/agent-registration.mjs
```

The probe uses the actual built Agent, Controller, Tool, PluginHost and loop,
with deterministic fake model adapters. It does not contact a live provider or
modify a user database.

| Case | Observed result |
| --- | --- |
| Two standalone Agents with different models/tools | Each loop receives its own model and declared tool set |
| Researcher admitted through the internal API into the existing Controller runtime | Events identify researcher and its model runs, but the request advertises the Controller Agent's `root_only` tool instead of researcher's `worker_only` |
| Initial Agent registry entry collides with a plugin registration | Existing registry rejects it with `RegistrationConflict` |

The shared-runtime case intentionally demonstrates an existing missing boundary;
the probe asserts the observed defect so its output is reproducible. It is not a
test asserting that this behavior is correct, and the internal `admit` call is
not a public delegation API proposal.

## External implementation evidence

These are API examples, not evidence about market-wide product adoption or
relative performance. External SDKs were inspected, not executed locally.

- [OpenAI Agents SDK orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
  documents agents-as-tools and handoffs as separate supported orchestration
  patterns. This supports explicit delegation as a real use case; it does not
  establish a particular Controller field for Tessar.
- [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
  defines available subagents in query options and invokes them through the
  Agent tool. It documents separate conversation context and tool restrictions.
- [Pi subagent extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
  implements delegation in an extension with isolated child contexts. This
  supports keeping orchestration outside Tessar's core loop.

## What must be implemented beyond the field

1. A typed Agent registration capability using one namespace for host and plugin
   registrations. Validate instances and nonempty IDs; reject collisions before
   making a registration available. Do not mutate the configured default.
2. Target-aware admission that uses the selected Agent's instructions, model,
   declared tools and budgets. Shared plugins/storage do not justify substituting
   the Controller default Agent's declared tool set.
3. A public execution capability for plugin handlers. It must produce ordinary
   Streams and preserve the existing loop, checkpoints and ownership rules.
4. Child reservation identity includes the target Agent as well as thread/stream
   and dispatch identity. A retry must not reuse one reservation for another
   Agent. Execution state/trace must retain the target for resume and recovery.
5. Proper resource ownership for registered Agents: plugin detach stops future
   admissions while active work keeps its captured dependencies; Controller
   shutdown observes all managed executions rather than only its default Agent.
6. Session selection and per-Agent thread listing must use the selected Agent ID.
   Merely adding an Agent collection must not silently reroute existing Sessions.
   Legacy threads currently lack Agent ownership; that requires an explicit
   compatibility decision, not a guessed migration or an Agent table.

## Plugin boundary

`subagents` supplies executable targets. It does not itself register a delegation
tool, write instruction sections, choose a target, summarize results or create
an execution during initialization.

A delegation plugin provides the tool/hook/command handler and decides fresh
context versus fork, scheduling, parallelism, process versus remote execution,
signal propagation, and result handling. In-process work uses the generic
execution capability; external dispatch uses the plugin's own executor and
tracked-effect/reconciliation contract where durable tracking is required.

Creating a background task, compaction call or child Agent must not require a
special branch in the core loop. This is the condition under which a declarative
`subagents` field remains compatible with the plugin philosophy.

## Evidence limits

No production multi-Agent runtime has been implemented by this assessment. The
probe proves standalone isolation, the current shared-runtime tool boundary gap,
and reuse of duplicate-ID checks. It does not prove multi-Agent cancellation,
restart, cross-process delegation or live provider behavior. Those need focused
implementation regressions before the selected API can be called complete.
