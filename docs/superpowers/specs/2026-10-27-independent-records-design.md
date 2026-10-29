# Independent storage records

Implement the record API approved in conversation before starting TypeSafe.
Records store independently inspectable JSON data without an Agent, Session,
Thread, Stream, tool or checkpoint requirement. Existing plugin state remains
unchanged. This is persistence, not an automatic logger or tracing integration.

## Approach

Extend existing storage backends rather than add another backend family or expose
driver connections and arbitrary DDL. SQLite/PostgreSQL use `tessar_records`;
MongoDB uses a collection of that name. In-memory storage supports the same API.
Schema initialization creates the new structure for existing databases without
rewriting runtime tables. Keep existing schema version handling unchanged.

## Public contract

- `backend.records.append({ namespace, data, id?, scope? })` returns a StoredRecord
  containing those fields, normalized scope, and a generated ISO `createdAt`.
- `backend.records.get(namespace, id, { scope? }?)` returns the record or null.
- `backend.records.list({ namespace, scope?, limit?, cursor? })` returns Page.
- PluginContext exposes the same operations at `tessar.storage.records` once
  Controller is ready, using its selected backend, including the memory default.

Data is JSON. Missing ID generates an unprefixed UUID. Identity is `(namespace,id)`;
duplicates reject with RegistrationConflict and never overwrite. Scope filtering
uses the existing subset semantics; scope is not an authentication system. List
requires namespace, sorts ascending by `(createdAt,id)` with ordinal ID ordering,
defaults to 50 entries and caps at 200. Cursor binding includes namespace/scope.
Returned values are immutable. No generic update/delete, data-field filtering,
automatic history injection, event hooks or TypeSafe implementation.

## Validation

Shared conformance cases cover standalone use, generated IDs, scope types and
unusual keys, duplicate protection, pagination, cursor isolation and JSON errors.
SQLite verifies reopen and additive schema creation. Plugin tests verify ready
access and memory fallback without requiring an execution. Run server conformance
against configured databases; explicitly report skipped checks.
