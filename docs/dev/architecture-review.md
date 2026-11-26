# Controller design

## Changing a system service

Start with the service descriptor for the affected node types. Each descriptor defines the public name, type, version, English summary and manual. Methods have JSON Schema for input and output, and events have a data schema. The catalog compiles these schemas once. A service and all its descendants are shared across every type that implements it. When its membership, schemas or semantics change, update the service version and the versions of changed features. Keep existing versions for unaffected services. [Catalog by node type](../../src/system-contract/index.ts) · [Feature definitions](../../src/system-contract/feature.ts)

Wire the corresponding handler or emitter to the same name. Calls check the target type, method permit, requested version and input before dispatch. TEAM creation expands omitted permissions before the caller’s argument check. The controller builds HELP from these descriptors, the active APP manifest and available runner features. Backend operations still check their own prerequisites, including runner availability and profile scope. [Dispatch and HELP](../../src/controller.ts) · [Store operations](../../src/store.ts)

Emit public system events from the affected node after committing a change. Compare the old and new values independently for status, last issue and stored rules. The APP’s executor failure and manifest source notifications target the APP itself. Revoke access and recheck active executors independently of whether a subscriber receives a notification. Test the advertised input, result and event data alongside the actual state transition. [Contract tests](../../tests/system-contract.test.ts)

Update examples, permissions, subscriptions and the web panel when a feature name or argument changes. A change can affect both allow and deny rules. The migration guide covers persisted rules and manifest files. [Node service contract upgrades](catalog-upgrade.md)

## Completing a call

The controller stores each open call under a system ID. An APP queue holds these IDs, and the runner receives the ID of its assigned call. Replies, cancellations, timeouts and runner loss all use the same completion operation. The first terminal outcome removes the record and clears its timer. A late reply receives an error. If a success result fails output schema validation, the controller leaves the call open so the worker can correct it.

Completing a call and releasing a worker slot can happen at different times. A client may already have received a timeout while the process is still running. The next assignment waits for that process to exit. [Implementation](../../src/controller.ts) · [Race condition tests](../../tests/controller.test.ts)

## Worker configuration

The controller validates the manifest when it creates an APP and caches the prepared configuration. It uses that configuration for `help`, validators and process settings. At dispatch, the controller computes the APP's effective permissions and passes the corresponding sandbox settings to the runner. [Manifest preparation](../../src/manifest.ts) · [Starting a process](runners/process.md)

Before applying a change, the controller prepares the new configuration and checks the APP's queue. A missing method, incompatible input or mismatch with the requested version causes a queued call to fail. For an assigned call the controller checks that the method still exists. If it does, the worker can reply with a result that meets the current output schema. After persisting the change, the controller updates the cache and rejects incompatible calls before dispatching more work.

During a manual stop, the slot stays occupied until the process exits. If the runner still has no exit confirmation one second after SIGKILL, it closes the process streams, releases the slot and reports an error. If the controller crashes while the APP is `stopping`, on the next startup it sets the APP to `error` and records the reason in `lastIssue`.

## File-based packages

Permission to install from a trusted directory extends trust to publisher updates, including a switch to another registered runner. The controller activates the prepared contract, subscriptions and launch settings together. A one-shot pool switches after validation. A running persistent process switches on exit. [Sources, file watching and HTTP](manifest-http.md)
