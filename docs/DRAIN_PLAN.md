# Drain on shutdown (follow-up (g))

Status: **IMPLEMENTED** on branch `phase6/closeout-1`, step 2, after the
reviewer approved this plan. Not deployed. Code: `src/drain.ts`, the shutdown
handler in `src/index.ts`, `GroupQueue.beginDrain()`, the active-run registry in
`src/container-runner.ts`. Tests: `src/drain.test.ts` plus the
`active-run registry` block in `src/container-runner.test.ts`.

The plan below is unchanged apart from this header and §8, which now records
the decisions instead of asking the questions.

Ruling (FABLE 2026-10-06, follow-up (g)): on SIGTERM, **refuse new work, wait a
bounded time for active runs to finish, then stop.** "Spare detached containers"
is rejected — a new process cannot reattach to an old container's output stream.

Today the opposite happens. `GroupQueue.shutdown()` ignores its grace argument,
logs `containers detached, not killed`, and returns immediately; `main()` then
exits. 3.5 seconds later the new process's `cleanupOrphans()` kills exactly the
containers that were "detached". That is the 2026-08-11 Haddock loss and the
2026-08-12 repeat, both recorded in STATUS (g).

---

## 1. The bound

`NANOCLAW_DRAIN_TIMEOUT_MS`, default **300000 (300s)**, read in `config.ts`
alongside the other timeouts. `TimeoutStopSec=330` in the unit (Part C) is this
bound plus 30s, so systemd never SIGKILLs us mid-drain. **The two must be
changed together.**

A second SIGTERM/SIGINT during a drain means "I meant it": log, skip the
remaining wait, go straight to step 5.

---

## 2. Refuse new work (and only new work)

`queue.shuttingDown` already blocks `enqueueMessageCheck()`, `enqueueTask()` and
`drainGroup()`. Four paths are NOT covered today and all four must be:

1. **`GroupQueue.sendMessage()`** — the message loop pipes newly arrived
   messages into a still-running container and advances `lastAgentTimestamp`
   (`index.ts:477`). During a drain that consumes a message the dying container
   will never answer. It must return `false` while draining, which makes the
   loop fall through to `enqueueMessageCheck()`, which no-ops. The message then
   stays unconsumed — see §3.
2. **`startInvocationPoller()`** — it calls `runContainerAgent()` directly and
   never touches the queue, so it would happily start a brand-new kernel-invoked
   container mid-drain. Needs the same guard, checked before `inProgress.add()`.
3. **`scheduleRetry()`'s timer** — already checks `shuttingDown` at fire time. OK
   as is; listed so it is not "fixed" twice.
4. **`proxyServer.close()`** — `shutdown()` currently closes the credential proxy
   **first**. Draining agents make fresh HTTP requests to it constantly, so
   closing it first guarantees every in-flight run fails. **Move it after the
   drain.** This is a real bug in the current shutdown order, not a new concern.

Channels stay connected through the drain and disconnect last, as they do today.
Keeping WhatsApp up means inbound messages still land in `store/messages.db`
while we wind down, and a draining agent can still deliver its reply.

---

## 3. Inbound messages during the drain are not lost

The guarantee rests on a distinction that already exists in `index.ts`:

- `lastTimestamp` — "the message loop has seen this". Advanced on arrival.
- `lastAgentTimestamp[jid]` — "an agent has been given this". Advanced **only**
  when messages are actually handed to a container, and rolled back on error
  when nothing was sent to the user (`index.ts:190-193`, `:259-260`).

`recoverPendingMessages()` at startup (`index.ts:721`) re-enqueues everything in
`store/messages.db` newer than `lastAgentTimestamp`. So a message is recovered
after restart **iff** the agent cursor never passed it. Writes go through
better-sqlite3 synchronously, so `saveState()` is durable the moment it returns —
there is no flush to lose.

Three cases, each ending in recovery:

| When the message arrives | What happens | After restart |
|---|---|---|
| During drain, no container active for that group | Stored; `enqueueMessageCheck()` no-ops under `shuttingDown`; agent cursor untouched | `recoverPendingMessages()` re-enqueues it |
| During drain, container active for that group | §2.1 makes `sendMessage()` return false, so the cursor is **not** advanced | same |
| Before drain, already handed to a container that we stop at the bound | Container exits non-zero → `processGroupMessages` sees `output === 'error'` with `outputSentToUser === false` → **rolls the cursor back** | re-processed |

The third case only holds if the rollback actually runs, so the drain must await
the in-flight `processGroupMessages` promises, not just the container processes
(§5). A message whose reply *was* already sent keeps the cursor advanced, which
is correct — rolling back there would duplicate the reply.

---

## 4. Knowing what is active

`queue.activeCount` is **not** sufficient: the invocation poller spawns outside
the queue, so kernel-invoked runs are invisible to it. Waiting on `activeCount`
would exit with a live Sketch or dashboard-invoked container running.

Add a module-level registry in `container-runner.ts`, populated inside
`runContainerAgent()` itself, so no spawn path can be missed:

```
activeRuns: Map<containerName, {
  group, agentId, runIdPromise, proc, closedByDrain: boolean
}>
```

Registered right after `spawn()`, deleted in the `close`/`error` handlers. This
is the single source of truth for the drain, and it also gives the drain the
`runId` it needs in §5 — the run id currently lives only in a closure.

---

## 5. The sequence

1. Log `drain: starting` with the active container names and the bound.
2. Set the refuse-new-work flags (§2). Leave channels and the proxy alone.
3. **Ask every active container to wind down**: write the `_close` sentinel for
   each active group (`queue.closeStdin`). Without this, a container that has
   already answered sits in its IPC wait until `IDLE_TIMEOUT` — **30 minutes by
   default**, far past the bound — and every drain would hit the timeout path.
   With it, the common case finishes in seconds.
4. Wait until `activeRuns` is empty or the bound elapses, polling ~250ms.
5. At the bound, for each container still listed — in this order:
   a. set `closedByDrain = true` (so the `close` handler does not also emit);
   b. `emitEvent(runId, 'run_ended', undefined, { reason: 'drain-timeout' })`
      through the normal emitter, so it is idempotency-keyed, queued on a kernel
      outage, and projected onto `runs.status` by the Q1 handler;
   c. `exec(stopContainer(name))` — explicit stop, never a silent orphan;
   d. log one WARN per container naming it and its run id.
6. Give the awaiting callers a short settle window (10s, not configurable) so
   `processGroupMessages` can run its cursor rollback (§3, case 3).
7. `proxyServer.close()`, then `await ch.disconnect()` for each channel, then
   `process.exit(0)`.

Steps 4-6 are wrapped so that any throw still reaches step 7 — a drain bug must
not wedge the shutdown and inherit a SIGKILL.

**Exactly one `run_ended` per run.** The `close` handler already emits one with
`exitCode`; `closedByDrain` suppresses it so a drain-killed run does not carry
two. The kernel would accept both (distinct idempotency keys) and the Q1
projection takes the first, but the transcript would read as two endings.

---

## 6. Interaction with `cleanupOrphans()` and startup reconciliation

Neither is removed. Both become no-ops on a clean shutdown, and both stay as the
backstop for the cases a drain cannot cover — crash, SIGKILL, power loss,
`TimeoutStopSec` exceeded.

- **`cleanupOrphans()`** (`index.ts:519`, before everything else at boot) kills
  every `nanoclaw-*` container. After a successful drain there are none, and
  after a timed-out drain we stopped them ourselves in §5c. Its destructive case
  only survives for genuine crashes. **This is the fix for (g):** the reaper
  stops racing the previous process, because the previous process no longer
  leaves anything behind.
- **`reconcileOrphanedRuns()`** (B-Q3, Phase 6 Condition 3) asks the kernel for
  `status=started` runs and closes them with `{"reason":"orphaned-on-restart"}`.
  A drained run is already closed — normally, or with `drain-timeout` — so the
  kernel no longer returns it and the reconciler skips it. **No change to
  `startup-reconcile.ts` is needed**, and the two reasons stay meaningfully
  distinct in the event log: `drain-timeout` means "we stopped it deliberately
  at the bound", `orphaned-on-restart` means "nobody closed it, we found it
  dangling". Note the file's own comment already anticipated this fix landing
  without touching it.
- Ordering caveat: `cleanupOrphans()` runs before `reconcileOrphanedRuns()`, so
  the reconciler's `hasRunningContainer()` skip path is still only exercised
  when a container survives the reaper. Drain makes that rarer, not more common;
  STATUS (g)'s remark that (g)'s fix would exercise the skip path does not hold
  for this shape, and that is fine — the skip path is a safety guard, not a
  feature that needs traffic.

---

## 7. What this plan does NOT do

- It does not make an in-flight run survive a restart. The ruling rejects that
  outright; the Phase 7 consequence is already recorded — an approval-pending
  run must not hold a live container, and resume is a fresh spawn rebuilt from
  the event log.
- It does not change `KillMode=process`. systemd must keep its hands off the
  `docker run` children while we drain.
- It does not drain `docker.service` restarts or a host reboot. Ruling 2-1's
  needrestart exclusion is the defence there; this is the complement, for
  Victor's own restarts and for `Restart=always`.

---

## 8. Decisions (were open questions)

1. **Scheduled tasks mid-drain: NOT rescheduled.** A task stopped at the bound
   takes the normal error path, so `updateTaskAfterRun()` advances it to its
   next scheduled slot — the missed occurrence is skipped, not retried. It must
   not vanish silently though, so the drain writes
   `cache/drain-interrupted.json` and `reportInterruptedRuns()` logs each
   cut-off task by id at the next startup, before recovery runs. Caveat worth
   knowing: that bookkeeping runs inside the settle window (§5.6). If the window
   expires first, `next_run` stays in the past and the scheduler picks the task
   up again after the restart — the startup log names it either way.
2. **The bound stays 300s**, tunable with `NANOCLAW_DRAIN_TIMEOUT_MS`.
   `TimeoutStopSec` is generated from the same default (`setup/service.ts`), so
   a fresh install stays consistent; an already-installed unit does not follow
   and must be edited by hand.
3. **Yes, one short outbound line on drain-timeout.** `drainNotice()`: a message
   run gets "I was restarted mid-task… please re-send your last message"; a
   scheduled task gets wording about its next scheduled time, because "re-send"
   is not the user action for a task nobody sent. Each send is bounded at 5s and
   its failure is swallowed; internal agents (synthetic `internal:` JIDs) own no
   channel and are skipped.

## 9. Post-bound time budget

`TimeoutStopSec` only grants 30s over the bound, so everything after step 4 is
parallel and bounded:

| phase | bound |
|---|---|
| per-run: resolve runId (1s) → `run_ended` emit (2.5s) → `docker stop -t 1` | all runs in parallel, ≈5s |
| notify (5s each) and settle (10s), concurrent | ≤10s |

≈15s of the 30s headroom, with the rest absorbing slow `docker stop` calls.
