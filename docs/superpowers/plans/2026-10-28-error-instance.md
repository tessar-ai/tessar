# Error Instance Guard Implementation Plan

> **For agentic workers:** Inline execution. User approved the design in conversation; no commits or publication requested.

**Goal:** Provide inherited, typed isInstance guards for Tessar's own errors.
**Architecture:** Extend existing TessarError with native constructor options and a generic static guard; migrate TypeSafe errors to this base and source-aware boundary checks.
**Tech Stack:** TypeScript ESM, Node >=24.22.1, pnpm 11.5.3, Vitest; no dependency.
**Spec:** docs/superpowers/specs/2026-10-28-error-instance-design.md

## Constraints and review focus

No IDs/markers or external SDK wrapping; no serialization/retry policy redesign.
Check polymorphic typing despite different subclass constructor arguments, false
positives for lookalikes, throwing proxies, preserved causes, and provider errors
passing through tool/plugin/storage boundaries without becoming core errors.

### Task 1: Error hierarchy and boundaries

- [x] Add failing runtime/type regression tests for guards, native options and source.
- [x] Add TessarErrorOptions and one polymorphic static isInstance implementation.
- [x] Update TypeSafe subclass constructors and every core inheritance-based source check.
- [x] Update errorFromInfo's options call; preserve existing provider fields/codes.
- [x] Run focused core/provider/TypeSafe tests and source/test typecheck.

### Task 2: Documentation, verification and audit

- [x] Update API references and developer error-handling examples.
- [x] Build and run package/integration checks and boundary validation.
- [x] Obtain independent correctness review and address important findings with regressions.
- [x] Run ponytail-audit repo-wide, report ranked findings separately without applying them.
