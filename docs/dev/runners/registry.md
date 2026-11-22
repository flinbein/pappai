# Runner registry

Manage runners through workspace methods (`node: "~"`). The caller must be a running APP or a USER with an unrestricted permission chain. Runner code executes with the controller's privileges. Install only trusted modules and keep their files accessible after container restarts.

| Method | Result |
|---|---|
| `$.runners.get({})` | Lists runners, paths, enabled state and availability. |
| `$.runners.add({name,entrypoint,settingsSchema?,config?})` | Registers a module, its APP settings schema and the installed runner's administrative configuration. Starts the host with IPC. |
| `$.runners.restart({name,config?})` | Stops the old workers, replaces the entire administrative configuration if supplied, reloads the code and publishes `$.app.restarted` for affected running APPs. Omitting `config` preserves the stored value. |
| `$.runners.disable({name})` | Stops the runner and moves affected running APPs to `error`. |
| `$.runners.enable({name})` | Starts a disabled runner. The operator starts APPs that are in `error`. |
| `$.runners.delete({name})` | Stops the runner and removes its registry entry. The built-in `process` runner can be disabled. |

The controller tracks each call's assigned worker. A runner host crash fails its pending calls. Routing between runners continues for available APPs. To update runner files, prepare compatible versions of the module and dependencies, then call `restart`.

## APP settings and contract

The manifest selects a registered name through `run.type`. For an external runner, `run.settings` is a JSON object with runner-defined fields. The controller compiles the optional `features` dictionary into the application contract and reads subscriptions from the common `subscriptions` section. It validates each candidate's settings against the registry's `settingsSchema` after applying overrides, extracting `features` and expanding `env` secrets. It can then add service addresses for a specific assignment to the environment. The built-in `process` runner defines the rules for `command`, `cwd` and `args`.

For example, a runner that accepts `{"prefix":"report "}` can register the schema `{"type":"object","properties":{"prefix":{"type":"string"}},"required":["prefix"],"additionalProperties":false}`. The manifest can declare a method in `features` alongside `prefix`. The registry list returns the saved schema. The v1 contract and schema are declarative. Dynamic contract negotiation with the runner process is planned.

## IPC messages

The controller opens the module with Node.js `fork()`. The host receives messages through `process.on("message", …)` and replies through `process.send({type,payload})`. Control IPC is separate from user process I/O. The host must enforce the supplied sandbox constraints or report launch failure.

| Controller → host | Action |
|---|---|
| `{type:"dispatch",job}` | Create a worker. The job includes its `id`, `appId`, `runnerType`, `mode`, `settings`, APP `sandbox` and first record (`from`, `method` or `event`, and `data`). It can include `maxLifetimeMs` and `runtimeMounts`. For a selected profile, `profileMcpNetwork` supplies the combined APP and PROFILE network decision for profile HTTP MCP. With `holdFirst:false`, an external runner delivers the first record itself. With `holdFirst:true`, the first assignment arrives in a separate `deliver` after startup. |
| `{type:"deliver",id,item}` | Deliver the record with its system ID. A persistent process must acknowledge each delivery with `written`. |
| `{type:"response",id,requestId,response}` | Deliver the result or error from a worker's outgoing request. |
| `{type:"reject",id,callId,message}` | The controller rejected the worker's reply. An invalid result can be corrected before the call deadline. |
| `{type:"notify",id,notification}` | Deliver a system notification to the worker. |
| `{type:"stop",id}`, `{type:"close"}` | Stop the specified worker or the entire host and its workers. Close IPC after completing `close`. |

| Host → controller, with `payload` fields | When to send |
|---|---|
| `started {appId,id}` | Confirm worker startup. |
| `written {appId,workerId,id}` | Record `id` was delivered to worker `workerId`. |
| `reply {appId,workerId,id,result}` or `{appId,workerId,id,error}` | Complete the assigned call. Here `id` is the system ID of that call. |
| `request {appId,workerId,id,method,params}` | The worker initiates an RPC with its own permissions. It will receive a `response` under its local request ID. |
| `exit {appId,id,issue?,startFailed?,stopFailed?}` | The worker has exited. The error fields distinguish launch failure from an unconfirmed stop. |

[External host test with a custom schema](../../../tests/custom-runner.test.ts) · [Built-in process runner](process.md)

The host receives the administrative `config` as JSON in `PAPPAI_RUNNER_CONFIG`. Registry listings omit its contents. The host announces relative PROFILE method names in a `profileMethods` message. The controller prefixes them with the registered runner name, checks permits and sends `profileCall` to the same host. A `profileRead` with an open call ID and a path requests up to 1 MiB from the caller's filesystem view. A `profileFile` reply carries the contents as base64 over IPC. Completion, cancellation, timeout or loss of the host ends the right to read again. [External runner example](codex.md)
