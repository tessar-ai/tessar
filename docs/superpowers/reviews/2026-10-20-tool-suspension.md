# Tool suspension review and release preparation

The fresh read-only review found three important lifecycle defects and no
critical defects. All three have regression tests that failed before their fixes
and passed afterward:

| Finding | Correction | Regression in `packages/core/test/agent-resume.test.ts` |
| --- | --- | --- |
| Synchronous admission failure left shutdown waiting forever | Roll back retained attachment state and settle cleanup before shutdown accesses it | `settles standalone retention when admission throws synchronously` |
| Rejected responses disabled the original cancellation handle and signal | Transfer cancellation ownership only after admission; serialize response attempts separately | `keeps the waiting handle/signal cancellable after an invalid response` |
| Direct cancellation retained a completed standalone runtime | Use the same disposal path for direct cancellation and waiting-handle abort | `releases a waiting standalone runtime after direct cancellation` |

The existing competing-response test now checks that the old handle becomes
stale after the `stream.resumed` event. An attempted response alone does not
transfer ownership: validation can reject it while leaving the request pending.

Verified locally on Windows: build, typecheck, public guide snippet typecheck,
package boundaries, 286 unit tests, 30 integration tests and 29 server-storage
tests. Storage tests exercised PostgreSQL. Unit tests skipped 39 cases whose
external prerequisites were unavailable; server-storage skipped 17 MongoDB cases
because no MongoDB test URL was configured. SQLite process tests cover recovery
after saving a question and after admitting an answer, without replaying execute.

Six `0.1.1` tarballs are prepared for `latest`. Release checks validate exports,
workspace dependency replacement and package identity; separate checks verify
Apache-2.0 license text, keywords and the `tessar-ai/tessar` repository metadata.
No registry publication, Git commit, push or tag was performed.

## Rulings

- Continue in the existing authorized feature checkout; preserve unrelated dirty
  work and the user's deletion of `SQLITE-STATE.md`.
- Add the agreed optional tool `resume` callback so approval can continue without
  replaying the original tool entry. Without it, the parsed answer is the result.
- Preserve one foreground execution per Session. Concurrent tabs use separate
  Sessions; this feature does not redesign Session scheduling.
- Cover public tool inference in the existing tool tests instead of duplicating
  the same cases in `public-types.test.ts`.
- Infer the complete execute return type, including promises. The approval guide
  exposed a compiler failure for conditional `Promise<string> | ToolSuspension`;
  the added type regression now passes.
- Keep provider HTTP execution, Linux, MongoDB, npm OIDC configuration and remote
  repository availability outside claims of local verification. Existing CI
  defines Linux, Windows and MongoDB/PostgreSQL jobs.

## Deferred minor

The event diagram in `examples/guide/stream.md` currently lists `input.received`
before `stream.started`; runtime emits these in the reverse order. This is a
documentation ordering issue, not a runtime sequencing change.

The separate [Ponytail audit](../audits/2026-10-20-ponytail-audit.md) lists small
simplifications without applying unrelated cleanup.
