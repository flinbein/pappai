# Pass file access to another APP

On Linux a method call can grant its executor temporary access to files belonging to the calling APP or USER. Put `read`, `write` and `create` next to `data` in the `call` parameters. A path in `data` tells the handler which file to use. Each grant string identifies one file. A trailing slash grants access to files in a directory and its descendants.

```json
{
  "node": "photo-processor",
  "method": "photo.process",
  "data": {"source": "/tmp/input.jpg", "output": "/tmp/photos/small.jpg"},
  "read": ["/tmp/input.jpg"],
  "create": ["/tmp/photos/"]
}
```

| Field | Operation on the caller's file |
|---|---|
| `read` | Read an existing regular file. |
| `create` | Create a new file exclusively. An existing name returns `EEXIST`. The parent directory must exist. |
| `write` | Write an existing file or create a new one. Add `read` if reading is also required. |

The controller checks the caller's current file permissions at open time. A sandboxed APP's `/tmp` maps to its private temporary directory. A grant belongs to a single call and ends on reply, failure, cancellation, timeout or disconnection of the calling executor. Interrupted writes may leave partial content. The handler can complete a call without using a grant.

Process executors can copy files in both directions or stream them through a private socket. [File protocol](dev/runners/files.md)
