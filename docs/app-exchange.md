# Events and method calls between APPs

Write feature descriptions, `doc` text and human-readable schema annotations in English. The controller returns the manifest author's text through `help()`. It does not translate stored manifests. Payloads may contain text in any language.

Declare an event in the publisher's `run.settings.features`. For example, `mail.received` takes an object with a required string field named `text`.

```json
{
  "mail.received": {
    "type":"event","description":"An email arrived","version":"1",
    "schema":{"data":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}}}
  }
}
```

Give the receiver permission for events from the publisher, and add a manifest subscription. Here `mailbox-id` is the publisher's ID from `dir`. For the receiver to call a publisher method, it also needs `methods` permission.

```json
{
  "permissions":[{"node":"mailbox-id","events":"mail.received","methods":"message.extractText"}]
}
```

```json
{
  "executors":{"mode":"oneShot","poolSize":3},
  "subscriptions":[{"node":"mailbox-id","events":"mail.received","priority":10}]
}
```

Start both APPs. The publisher writes a `publish` request to stdout. For targeted delivery, set `params.to` to the recipient ID. The controller checks event data, receiver permissions and subscriptions. After reading the event from stdin, a handler can write a `call` request to stdout and wait for the response on stdin. See the [JSONL contract](dev/runners/process.md) for complete messages.

In `oneShot` mode the shared APP pool permits 1 to 20 concurrent processes. In `persistent` mode one process runs at a time. Set `idleTimeoutMs` to terminate an idle process or use `null` to disable the timer. For automatic recovery attempts, set `maxRestarts` and subscribe to the APP's own `$.app.executor.failed` event. A `working` APP can accept work even without a running process.

Events and calls share a queue of up to 100 pending entries. Higher `priority` gets an earlier slot. Ties retain arrival order. When the queue is full, `canEvict:true` can remove the oldest entry at the lowest priority if that priority is at most the incoming priority. For calls, configure these fields in the method declaration. An evicted call fails.

## Personal subscriptions

`$.node.subscriptions.get/set/add/delete/enable/disable` manage an APP's personal list. Each operation requires permission for its method. Manifest rules run first, followed by personal rules. Disabled rules are skipped. A matching `deny:true` ends delivery. The first allowing rule with room determines event priority. The optional `caughtBy` condition checks whether another selected APP, whose delivery the receiver may observe, accepted the event.

To add a rule, pass `{"subscriptions":[{"id":"inbox","node":"mailbox-id","events":"mail.received"}]}`. A personal ID must be unique within the APP. Use `before` or `after` with an existing rule ID to position it. Using `true` places the rule at the beginning or end respectively. To disable it, pass `{"ids":["inbox"]}` to `$.node.subscriptions.disable`. Replacement, insertion and deletion are validated in full before saving. Accepted events retain their original priority and subscription ID.

[Manage an APP](manage-app.md) · [Configure a workspace](workspace.md)

## USER and browser tab subscriptions

A USER session can open `/ws/events` on the panel host. The WebSocket checks the origin and session cookie. Each connection starts with an empty subscription list. The tab re-establishes its subscriptions after reconnecting. Commands use JSON-RPC 2.0.

```jsonl
{"jsonrpc":"2.0","id":1,"method":"subscriptions.add","params":{"subscriptions":[{"id":"mail","node":"mailbox-id","events":"mail.received"}]}}
{"jsonrpc":"2.0","id":1,"result":{}}
{"jsonrpc":"2.0","method":"event","params":{"from":"mailbox-id","event":"mail.received","subscription":"mail","data":{"text":"Hello"}}}
```

A connection subscription has an ID, a source selector and event names. The commands `subscriptions.get/set/add/delete/enable/disable` manage the current tab's list. USER permissions determine the available sources and events. Delivery to a USER succeeds when at least one matching connection receives the event. The controller does not retain missed events for the next sign-in.

The connection supports `dir`, `help`, `call`, `publish` and `cancel`. To cancel an outstanding `call` with ID 42 on that connection, pass `{"id":42}` to `cancel`. Disconnecting cancels the connection's outstanding calls.

## Delivery reports

Set `delivery:"status"` in `publish` to see the state at publication, or `delivery:"track"` to follow delivery to the executors. The default is `"none"`. The publisher needs `delivery:true` permission for recipients. It can always observe its own delivery.

```json
{"publication":"publication-id","deliveries":[{"node":"receiver-id","status":"queued"}]}
```

`queued` means the event was accepted and the stdin write is pending. `delivered` means the write completed or a WebSocket received the event. `rejected` covers refusal or queue clearing. `unknown` means the outcome could not be determined. A `timeout` ends tracking and leaves the event queued.

In `track` mode JSONL emits one line such as `{"delivery":{"publication":"…","node":"…","status":"delivered"}}` for each visible recipient that was initially `queued`. WebSocket clients receive a notification with `method:"delivery"`. HTTP RPC collects final states in the response. Set `timeoutMs` between 1 and 86,400,000 milliseconds. The default limit is one day. Subsequent notifications belong to the publisher's connection.
