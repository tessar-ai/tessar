# Memory lifecycle measurements

Measured on Windows with Node 24.22.2 and forced GC, using a local model adapter
that returns `ok` without retaining requests. These are single-run retained-heap
measurements relative to the heap after setup, not RSS or a timing benchmark.

## Default memory backend

One Session/Thread, sequential turns, 8 KiB of fresh text per turn. Wait for each
execution to end and force GC before recording heap usage.

| Turns | New input | Before retained heap | After retained heap |
| ---: | ---: | ---: | ---: |
| 10 | 0.08 MiB | 5.65 MiB | 0.95 MiB |
| 20 | 0.16 MiB | 19.08 MiB | 1.56 MiB |
| 40 | 0.31 MiB | 71.73 MiB | 2.85 MiB |

The backend still retains checkpoint history. Unchanged frozen message/record
payloads are shared instead of copied into every checkpoint. Checkpoint containers,
IDs and changed versions still consume memory; this does not make unlimited
in-memory history constant-space storage.

## PostgreSQL and runtime caches

Used the existing local `test` database with separate retained UUID schemas.
No server extension was installed or changed.

- Visit 125 idle Sessions containing 32 KiB of history each: 100 cached handles
  remain after pruning. After Tessar shutdown, zero extra handles remain after GC.
- While the model waits, send 500 HTTP follow-ups containing 32 KiB each:
  100 accepted, 400 rejected with 429, 100 queued. Retained heap: 3.54 MiB,
  compared with 17.01 MiB when all 500 were accepted before the fix.
- Send 200 transient signals containing 16 KiB each: 100 accepted, 100 rejected,
  100 pending. Retained heap: 1.64 MiB, compared with 3.23 MiB for 200 before.
- Abort execution: queued input returns to zero.
- Remove a provider 30 times: zero cached profiles remain, compared with 30 before.
- Close a memory backend while retaining its handle: owned plugin state is
  collectible, confirmed with a WeakRef and GC.

Raw after-measurements are in ignored `benchmark/results/memory-audit-after.json`.
Active executions, SSE viewers, interruptions and pending input are protected from
idle cache eviction. Applications still own concurrency and storage retention.
