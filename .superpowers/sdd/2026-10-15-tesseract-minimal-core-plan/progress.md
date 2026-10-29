# SDD ledger — plan: docs/superpowers/plans/2026-10-15-tesseract-minimal-core-plan.md
Task 1: in_progress; user authorized rewrite plus native implementation. Old migration/source/tests preserved.
Ruling: user explicitly requested writing the English spec/plan then starting implementation — proceed with preserved native method without another approval checkpoint — cost if wrong: wording decisions require correction in the same branch.
Ruling: .git remains read-only — do not bypass commit permissions; verify and preserve workspace changes — cost if wrong: user must commit later.
Pre-flight: Task1 event metadata is stored per PluginHost; Task2 Agent uses that host directly; Task3 Session uses observer delivery and EventMap; Task4 exercises only public built imports. Existing storage/provider contracts remain unchanged.
Tasks 1-3: implementation present; unit89/89, strict typecheck and build PASS. Actual SQLite process race exposed intermittent WAL initialization BUSY; bounded async retry added at schema setup, without changing execution retry semantics. Final gates still pending.
Task 1: complete; string/hook/plugin tests GREEN, strict public type-map checks pass; no required apiVersion or core event prefixes.
Task 2: complete; Agent owns loop; core Controller/Thread/model APIs pass tests, old SDK directory removed, no runtime bridge.
Task 3: complete; Session subscription/FIFO/model binding/HITL/discard/scope/fork/dispose tests pass. Terminal-observer lease race and notification capability leak reproduced RED then fixed GREEN.
Task 4: implementation complete; pnpm install --frozen-lockfile/typecheck/build/test(92/92)/test:integration(7/7)/check:boundaries/git diff --check PASS. Actual SQLite process recovery and built CLI restart HITL included; no live OpenAI call. Fresh final review pending.
Additional fixes: plugin attach/shutdown disposal race and Session barrier override reproduced RED then GREEN; SQLite WAL startup BUSY fixed after actual process failure.
Final review: fresh reviewer returned three independently reproduced Important findings, then failed due to usage limit before its final report. Author completed targeted remaining inspection; no second reviewer was dispatched.
Final: Ruling: finish the review with direct inspection after reviewer usage exhaustion — preserve the confirmed independent findings and complete authorized work without another review dispatch — cost if wrong: incomplete independent coverage may miss additional defects.
Final: fixed ignored BeforeTool stop and swallowed policy exception — parameterized BeforeTool stop/throw regressions RED->GREEN, full unit suite 97/97.
Final: fixed terminal streams leaving active turns running and turn-end notifications preceding publication — failed/cancelled terminal turn regressions RED->GREEN, full unit suite 97/97.
Final: fixed Session accepting input during BeforeClose — gated close/rejected-close regression RED->GREEN, full unit suite 97/97.
Final: fixed package omission of models.dev MIT license — pnpm pack --dry-run --json license assertion RED->GREEN.
Final: fixed examples being ignored by Git — git check-ignore reproduced exclusion, removing the broad examples ignore makes all seven example sources/configs reviewable.
Final: minor (deferred): Controller.initialize after disposal returns the previous fulfilled promise; actual runtime APIs still reject with Disposed. Reproduced using built public imports.
Task 4: complete; frozen install PASS, typecheck PASS, five workspace builds PASS, unit97/97 PASS, integration7/7 PASS, boundaries PASS, package-license check PASS, examples visibility PASS, diff check PASS. No live OpenAI or hosted CI. Final review limitation is stated in the spec/plan.
Final state: existing implementation now at HEAD 02d7631 from an external commit; final corrections and example sources remain in the worktree. Current permission profile still disallows Git writes. Ledger retained because final corrections cannot be committed here.
