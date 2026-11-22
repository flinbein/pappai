# The process runner

The `process` runner executes methods and receives subscribed events. The controller maintains the queue, validates the contract and reserves a slot before starting a process. [Configuring pools and subscriptions](../../app-exchange.md)

## stdin and stdout

Each record ends with a newline. Events, incoming calls and replies to the process's own requests all arrive on the same stdin stream. A single pipe read can contain several lines or part of a line. In Node.js, use `readline.createInterface({input:process.stdin})`.

An incoming call on stdin and its reply on stdout look like this.

```jsonl
{"from":"chat-agent","id":"call-7","method":"message.extractText","data":{"text":"  Hello  "}}
{"id":"call-7","result":"Hello"}
```

An event occupies one line on stdin. Delivery under a personal subscription rule includes the rule's ID.

```jsonl
{"from":"mailbox","event":"mail.received","subscription":"inbox","data":{"text":"Hello"}}
```

The process sends its own requests on stdout. The reply returns to the same worker's stdin with the same local ID.

```jsonl
{"id":"request-1","method":"call","params":{"node":"extract","method":"message.extractText","data":{"text":"  Hello  "},"timeoutMs":5000}}
{"id":"request-1","result":"Hello"}
```

`dir` and `help` use the same APP permissions as outgoing calls. To publish, the process names an event from its current contract.

```jsonl
{"id":"request-2","method":"publish","params":{"event":"mail.received","data":{"text":"Hello"}}}
{"id":"request-2","result":{}}
```

The controller identifies the source from the host's private IPC channel. It matches every reply to the APP, worker instance and open call. A result that fails the output schema returns an error on stdin. The worker can correct its result using the same system ID. Completion, cancellation or expiry of a call ends the handler's authority to reply. The controller does not replay side effects automatically. The process writes diagnostics to stderr. On an abnormal exit the host logs the last 2 KiB. [Example handler](../../../examples/extract-text/extract.cjs)

## Work delivery

In `oneShot` mode the process receives one work record. Its stdin stays open for replies to its own requests, and the slot remains occupied until the process exits. In `persistent` mode one process gets the next record as soon as the previous line has been written to stdin. When the pipe fills, remaining work waits in the controller's bounded queue. The host accepts up to 32 concurrent open requests from a process. Local request IDs must be nonempty strings of up to 255 characters, unique among that process's open requests.

Starting an APP enables it to accept work. The first matching record starts a process. A background service can subscribe to `$.app.statusChanged`, `$.workspace.init` and `$.app.restarted`. When a persistent process fails and a retry is available, the controller publishes the local `$.app.executor.failed` event. Once retries are exhausted, the APP enters `error` and its queue is cleared. A manual restart preserves queue order, deadlines and accepted events. Calls already delivered to a process fail if it exits without replying. One-shot workers finish their accepted work. When the contract changes, queued calls are checked against the new input and version. Results are checked against the current output schema.

## Starting the sandbox

A fully unrestricted applicable chain of `permissions:null` allows a trusted process to run directly on the OS. If the APP has restrictions, the Linux runner uses bubblewrap and fails the launch if it cannot establish isolation.

The Linux runner builds mounts from the APP's allowed paths and exclusions. An explicit file grant requires an existing absolute path without symbolic links. The sandbox gets new `/proc` and `/dev` mounts, the APP's private directory as `/tmp`, and read-only system directories `/bin`, `/sbin`, `/lib`, `/usr` and `/etc` subject to masks. Selecting a working directory does not grant access to its contents. With network access denied, the process gets a separate network namespace.

The host limits process lifetime when `maxLifetimeMs` is set. On shutdown it sends SIGINT, then SIGKILL after 10 seconds. If the host crashes, bubblewrap and the PID namespace terminate sandboxed processes. Background descendants of trusted processes running outside the sandbox can outlive the host. Each runner host belongs to one controller.

## Linux tests

Alpine requires Node.js 24 or later, the project dependencies and bubblewrap. The following checks were verified on Docker Desktop with Linux containers.

- With `--cap-add SYS_ADMIN --security-opt seccomp=unconfined`, set `PAPPAI_TEST_BWRAP=1` and run `node --test tests/runner.test.ts tests/runner-loss.test.ts` from the project directory. The tests check a single-file mount, a hidden sibling file, a separate network, denial of access to working-directory contents and the effect of a shared runner crash.
- Under ordinary Docker restrictions that prevent namespace creation, set `PAPPAI_TEST_BWRAP_DENIED=1` and run `node --test --test-name-pattern "failed OS" tests/runner.test.ts`. The test expects isolation to fail and the worker to produce no reply.

The required Docker options depend on host policy. The test container includes the `tests/` directory, which is excluded from the released application image.
