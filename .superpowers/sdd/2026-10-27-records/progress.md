# SDD ledger — plan: docs/superpowers/plans/2026-10-27-independent-records.md

User authorized inline implementation of the discussed record persistence API before TypeSafe.

Pre-flight: all backend tasks consume the same RecordStore/StoredRecord contract; plugin access delegates to that port. No conflicting interfaces found.

Task 1: complete — core DTO/port, shared preparation, memory/SQLite/PostgreSQL/MongoDB implementations and additive schema/indexes. RED observed: 7 failing new checks before records existed. Focused checks passed after implementation.
Task 2: complete — plugin ready access/default memory, storage error attribution, SQLite reopen/additive schema and server duplicate-race checks. Record data remains independent of checkpoint state and survives Thread purge.
Task 3: complete — guide, API reference, package READMEs and SQLite inspection example updated. Live SQLite demo seed/inspect/resume/inspect passed in separate processes.

Verification:
- Node 24.22.1 workspace build passed.
- Source/test typecheck passed; boundaries passed; git diff --check passed.
- Full package suite with configured PostgreSQL: 529 passed, 23 skipped (MongoDB URL absent), 88 files.
- Integration: 43 passed, 9 files.
- Fresh independent reviewer: no important new defects. Independently ran 8 focused checks.
- Optional review notes addressed: explicit equal-createdAt ordering/cursor check on PostgreSQL; README documents inherited native JSONB Unicode limits.

Ruling: record data uses each backend's existing JSON representation and native limits. No rewrite of PostgreSQL JSONB encoding or MongoDB document-size handling.
Ruling: plugin record operations require ready Controller, including default memory, rather than depend on plugin setup order. Direct backend use remains independent of Controller.
No changes to TypeSafe, package versions, commits or publication.
