# OpenTelemetry Package Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver one class-based Tessar tracing plugin with OTLP, Langfuse, Arize and Traceloop adapters.

**Architecture:** Keep existing lifecycle/model/tool modules. Replace platform
attributes in their shared tracing runtime with neutral OTel/Tessar attributes.
Each adapter owns its exporter and maps a separate span snapshot.

**Tech Stack:** TypeScript ESM, Node >=24.22.1, pnpm 11.5.3, OTel SDK 2.12.0 and OTLP HTTP exporter 0.223.0.

**Spec:** `docs/superpowers/specs/2026-10-23-opentelemetry.md`

## Global Constraints

- Public implementations are classes; package index files only export APIs.
- Preserve Core, hooks and established tracing lifecycle behavior.
- Use native SDK OTLP encoding, batching and shutdown; no platform SDKs.
- Do not publish, push, tag, or alter unrelated changes.

## Review Focus

- Multiple adapters must preserve identical IDs without attribute contamination.
- Missing credentials and partial setup must not leak exporters.
- HTTP failures must not fail agent execution or disposal.
- Unknown usage stays unknown; cached/reasoning tokens must not be double counted.
- Thread restart/resume and auxiliary model calls retain correct parents.

## Task 1: Rename and implement generic tracing with class adapters

- [x] Rename package, workspace references and consumers.
- [x] Add failing real OTLP collector tests for four adapters and shared IDs.
- [x] Implement neutral attributes, adapter classes and separate snapshots.
- [x] Retarget existing lifecycle regression tests using a capture adapter.
- [x] Pass package tests, typecheck and builds.

## Task 2: Validate the public package and document migration

- [x] Update package README, guides, public-import fixture and release examples.
- [x] Run built public consumer and tarball checks.
- [x] Run package/integration tests and boundary checks.
- [x] Review exports, dependencies and outstanding limitations.


