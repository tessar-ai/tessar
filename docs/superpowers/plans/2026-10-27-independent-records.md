# Independent Records Implementation Plan

> **For agentic workers:** Execute inline using superpowers:executing-plans. No commits or publication are requested.

**Goal:** Persist and query independent JSON records through every Tessar backend.
**Architecture:** Add one storage port and one table/collection per durable backend; reuse scope, pagination, JSON and error handling. Plugin access delegates to the ready Controller backend.
**Tech Stack:** TypeScript ESM, Node >=24.22.1, pnpm 11.5.3, Vitest, node:sqlite, pg, mongodb.
**Spec:** docs/superpowers/specs/2026-10-27-independent-records-design.md

## Constraints and review focus

- Preserve unrelated work and all existing checkpoint/plugin-state behavior.
- No new dependency, migration framework, raw driver API, TypeSafe or release work.
- Check duplicate races, JSON/scope validation, cursor query binding, namespace
  isolation and persistence when no runtime objects exist.

### Task 1: Backend records

- [x] Add shared failing conformance tests in `packages/core/src/testing/storage-conformance.ts`.
- [x] Add record DTO/port and shared preparation validation in core state.
- [x] Implement memory and SQLite, including additive `tessar_records` schema/index.
- [x] Implement PostgreSQL/MongoDB with the same semantics and indexed paging.
- [x] Run core/SQLite conformance and configured server tests.

### Task 2: Plugin access and persistence checks

- [x] Test plugin access without an execution, default memory, before-ready rejection.
- [x] Expose typed `tessar.storage.records` through the Controller's ready backend.
- [x] Include the new port in storage error attribution.
- [x] Test SQLite close/reopen, additive schema, and concurrent duplicate inserts.

### Task 3: Documentation and verification

- [x] Update API reference, plugin docs and storage guide with signatures/examples.
- [x] Extend the SQLite inspection example to exercise independent record storage.
- [x] Run typecheck, build, package tests, integration tests and boundaries.
- [x] Review complete diff for inconsistent behavior and unnecessary public API.
