# Controller design

## Completing a call

The controller stores each open call under a system ID. An APP queue holds these IDs, and the runner receives the ID of its assigned call. Replies, cancellations, timeouts and runner loss all use the same completion operation. The first terminal outcome removes the record and clears its timer. A late reply receives an error. If a success result fails output schema validation, the controller leaves the call open so the worker can correct it.

Completing a call and releasing a worker slot can happen at different times. A client may already have received a timeout while the process is still running. The next assignment waits for that process to exit. [Implementation](../../src/controller.ts) · [Race condition tests](../../tests/controller.test.ts)

## Worker configuration

The controller validates the manifest when it creates an APP and caches the prepared configuration. It uses that configuration for `help`, validators and process settings. At dispatch, the controller computes the APP's effective permissions and passes the corresponding sandbox settings to the runner. [Manifest preparation](../../src/manifest.ts) · [Starting a process](runners/process.md)

Before applying a change, the controller prepares the new configuration and checks the APP's queue. A missing method, incompatible input or mismatch with the requested version causes a queued call to fail. For an assigned call the controller checks that the method still exists. If it does, the worker can reply with a result that meets the current output schema. After persisting the change, the controller updates the cache and rejects incompatible calls before dispatching more work.

During a manual stop, the slot stays occupied until the process exits. If the runner still has no exit confirmation one second after SIGKILL, it closes the process streams, releases the slot and reports an error. If the controller crashes while the APP is `stopping`, on the next startup it sets the APP to `error` and records the reason in `lastIssue`.

## File-based packages

Permission to install from a trusted directory extends trust to publisher updates, including a switch to another registered runner. The controller activates the prepared contract, subscriptions and launch settings together. A one-shot pool switches after validation. A running persistent process switches on exit. [Sources, file watching and HTTP](manifest-http.md)
