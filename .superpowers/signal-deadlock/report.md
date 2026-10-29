# Signal deadlock check — 2026-10-21

## Evidence and scope

Ran 46 isolated runtime probes against freshly built public `@tessar/core`.
Each worker loads an actual external `.mjs` plugin through `PluginManager.load()`.
The plugin obtains the host Agent through hook `context.registry`; no Agent
instance is injected into its constructor. Models are ScriptedProvider fixtures,
storage is the real core MemoryBackend. No GitHub/Slack API calls were performed.

Reproduce: `node .superpowers/signal-deadlock/check.mjs`.
Detailed traces: `results.json` and `output.log` beside this report.
SDK source behavior was not changed for this investigation.

## Actual deadlocks reproduced

These require a Controller-bound direct `agent.stream(..., { id })`. During the
creation of its internal Thread, a plugin awaits a signal addressed to that same
reserved Stream ID:

| Hook | Persist | Result |
| --- | --- | --- |
| `thread.prepare` | true | Circular wait |
| `thread.started` | true | Circular wait |
| `thread.prepare` | false | Circular wait too |

The exact dependency is:

```text
Agent.admit waits for prepareThread
prepareThread waits for thread.prepare / thread.started hook
hook waits for sendSignal acknowledgement
sendSignal waits for mailbox.ready
mailbox.ready requires InputCommitted in execute
execute cannot start until prepareThread returns
```

Source: `agent.ts:309-321`, `state/thread-operations.ts:21-43`,
`engine/signals.ts:90-97`, `engine/execution.ts:221-223`.

The current guard only rejects when a frame exists and is not admitted. During
these two Thread hooks no frame exists yet, so that guard misses the cycle.

Each probe observed no provider call and no hook return while the receipt was
pending. A diagnostic escape explicitly released the hook without waiting for
the receipt; only then did execution proceed and the receipt resolve. This escape
is confined to the diagnostic plugin, not a production SDK fix.

## Rejections, not deadlocks

| Condition | Observed result |
| --- | --- |
| Await same Stream signal from `input.prepare` | `InvalidTransition` |
| Original input `message.prepare` / `message.beforeCommit` | `InvalidTransition` |
| Initial input checkpoint's `checkpoint.committed` / `thread.updated` | `InvalidTransition` |
| External callback while `input.prepare` is paused | `InvalidTransition` — overbroad guard |
| `input.prepare` using Session `threadId` target | `InvalidTransition` |
| `input.prepare`, persist false | `InvalidTransition` |
| `stream.beforeEnd` / `stream.end`, same Stream | `AlreadyTerminal` |
| `stream.beforeEnd`, Session Thread target | `AlreadyTerminal` |

The admission guard cannot distinguish an external sender from a hook sender.
The external-callback rejection is an implementation limitation, not evidence
that the external callback would create a cycle.

## Awaited sends that completed

Receipts resolved from `stream.started`, `input.received`, `stream.before`,
`turn.start`, `model.select`, `tools.select`, `context.prepare`, `model.request`,
`model.start`, `message.delta`, `model.usage`, `model.response`,
`message.committed`, `model.end`, `turn.end`, `turn.decision`, `tool.before`,
`tool.prepare`, `tool.start`, `tool.result`, `tool.end` and `tool.execute`.

Assistant message preparation/before-commit hooks completed too, as did
checkpoint/thread-update hooks after `stream.started`. These probes send once;
they do not continually generate a new signal on every checkpoint.

Session `session.threadCreated` completed both when awaiting the receipt directly
and when registering a timer and returning first. An `input.prepare` hook that
registered a timer and returned also completed: its timer fired after admission.

External plugin callbacks received acknowledgements while the model or tool was
still deliberately blocked. An external callback during `thread.prepare` waited
until that hook's independent gate was released; because the hook did not await
the signal, this was an ordinary wait, not a dependency cycle.

## Outcome

46 probe expectations checked: 31 immediate successful receipts, 11 explicit
rejections, 3 reproduced circular waits, 1 ordinary pre-admission wait. Every
execution completed after diagnostic gates were released. These are current
observed cases, not a guarantee about arbitrary plugin code or external services.
