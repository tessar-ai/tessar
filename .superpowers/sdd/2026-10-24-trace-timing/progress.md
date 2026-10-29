# SDD ledger — plan: docs/superpowers/plans/2026-10-24-trace-timing.md

Task 1: complete — regression failed on delayed Session Turn start, then passed
using the retained turn.start timestamp without changing numbering or span IDs.

Task 2: complete — success/failure parallel-tool regressions failed, then passed
using optional tool.end.endedAt from the existing execution record. Notification
order and storage behavior remain unchanged. Existing restart/resume remains
valid; a focused cached-result notification test checks that a new observation
without a fresh tool start is not backdated before its own start.

Verification: 374 package tests passed, 39 skipped; source/test typecheck,
dependency boundaries and full workspace build passed. All 43 integration tests
passed. The final focused tracing suite has 21 passing tests after adding the
cached-notification regression.

Task 3: implemented and locally verified — new recording Agent root/trace for
each invocation or resume/recovery segment, grouped by Thread in Langfuse Sessions.
Persist only Turn counters; no ended parent reuse. Fresh observation IDs retain
logical Stream/Turn IDs. Cover follow-ups, switching, completed restart, Session
resume, direct Agent resume and cached tool publication before stream.resumed.
Cloud API grouping has not been verified during the current audit.

Task 4: complete — user approved optional realtime=false. A native processor
behavior regression failed for true and passed after selecting SimpleSpanProcessor;
omitted/false retain BatchSpanProcessor. Verified multiple adapters, unfinished
spans staying private, final flushing, HTTP 200/401 behavior and setup cleanup.
Final verification: 29 tracing tests and 4 built public-import tests passed;
source/test typecheck, package build and dependency boundaries passed. No Core
execution, adapter payload mapping, dependency or package-version changes for this task.

Ruling: keep changes in the existing checkout and do not commit — the user has
authorized ongoing changes here; unrelated dirty work and read-only Git are preserved.

Task 5: user challenged tool-only timing and requested framework consistency.
Added record times to Stream/Turn/model/tool lifecycle payloads and regressions;
auxiliary/tool errors now capture completion before their notification and retain
that value when finalizing the record. No hook/persistence ordering changed.
Tracing consumers and timing documentation still require a coordinated update.

The user then requested a whole-codebase consistency audit. Completed source
review plus executable built-package probes: tool manifest schema compatibility,
Agent/Session connection overrides and option validation, error provenance,
subscriber vs hook publication, parent/Session disposal, missing timestamps and
tool aliases. See docs/consistency-audit.md (nine findings). No audit fixes applied.
Current verification: build, typecheck, boundaries, 388 package tests and 43
integration tests pass; 39 tests skipped. Actual DB servers/Cloud not tested.

Superseded status, 2026-10-25: the user authorized C01-C09 fixes and Langfuse
completion. See ../2026-10-24-consistency-fixes/progress.md for execution evidence.
Timing consumers, root/segment grouping, realtime and documentation are now complete.
Final verification: build/typecheck/boundaries/diff checks passed, 405 package tests
passed (39 skipped), 43 integration tests passed. Independent final review found
no remaining important correctness issue. Langfuse Cloud API received 9+3
observations across two invocation traces in one Thread group; a generation was
visible before execution completed. No actual DB servers or dashboard UI inspected.
