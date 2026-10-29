# SDD ledger — plan: docs/superpowers/plans/2026-10-28-error-instance.md

Approved in conversation: shared TessarError base; one inherited polymorphic
isInstance; real prototype identity only; no errorId, marker or package names.
Constructor super(code,message,{source?,details?,cause?}); name is display only.
User additionally requested ponytail-audit after implementation.

Pre-flight: existing source guards previously treated all TessarError descendants
as core. New hierarchy separates source from inheritance. TypeSafe public
constructors and error-code values remain intact. Existing dirty work preserved.

Task 1: complete — four runtime tests failed before implementation; new base guard,
options, native cause, TypeSafe inheritance and source-aware boundaries now pass.
Inherited narrowing is tested in reachable code so TypeScript actually checks
control flow; no unreachable-if(false) assumption for narrowing tests.
Task 2: complete — docs/guide updated, independent review and verification done,
then repo-wide ponytail-audit reported separately without applying suggestions.

Verification:
- Build passed (Node 24.22.1/pnpm 11.5.3).
- Source/test typecheck, boundaries and git diff --check passed.
- Focused core/provider/TypeSafe suite: 180 passed.
- Full package suite: 556 passed, 23 skipped (MongoDB URL absent).
- Integration: 44 passed, including built HTTP/SQLite consumer with inherited guards.
- Full first run had one npm-plugin subprocess hit its existing 25s timeout;
  isolated retry (4 tests) and full suite rerun passed without changing its code.
- Fresh reviewer: no important findings; independent typecheck and 12 checks passed.
  Optional extra direct executeTool regression deferred; source behavior is covered
  by the broader tools suite and existing source checks.

Decisions: no code catalog, retryable deletion or persisted stack/cause redesign.
errorFromInfo only adopts the new constructor options; no provider-class factories.
No dependency, publication, package version bump, git commit or external SDK wrapping.

Audit: docs/ponytail-audit-2026-10-28.md, 4 small simplifications (~26 source lines,
0 dependencies), including newly redundant origin guards and TypeSafe detail copy.
Report only: no automatic audit fixes applied.

Follow-up approved by user ("ok làm"): all four audit suggestions applied.
- TypeSafe records use errorInfo directly: provider fields live in error.details;
  native thrown error fields remain unchanged. Tests and guides updated.
- Error boundaries pass origin directly; source/first provenance stay centralized.
  Added checks for core/provider source and boundary IDs including executeTool.
- Removed unreachable Controller phase guard and duplicate hookKinds fallback.
  Dispatcher recovery rethrow gate remains covered for all three reserved codes.
- Regression checks failed before source changes (missing IDs/duplicate fields).
- Fresh verification: build, typecheck, boundaries, diff check pass;
  560 package tests pass/23 MongoDB tests skipped; 44 integration tests pass.
- Fresh read-only correctness reviewer: no findings in the four cleanups.
