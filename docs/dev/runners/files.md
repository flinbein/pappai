# File requests from a process worker

The handler writes requests to stdout and reads replies carrying the same worker-local string `id` from stdin. Set `callId` to the system ID of the assigned method call. The controller checks the worker instance, assignment, path scope and current file permissions. Finish file operations before returning a successful result for the assignment. [Delegation format](../../delegated-files.md) · [Process transport](process.md)

## Copying a file

For a running process, the controller uses both its filesystem view at launch and the permits in effect when it opens the file. An expansion of access takes effect for the next worker instance. Narrower permissions apply to new file operations immediately. A `/tmp` path remains bound to the filesystem of the worker that granted it.

```jsonl
{"id":"copy-1","method":"files.copy","params":{"callId":"call-58","from":{"self":"/tmp/photo.png"},"to":{"caller":"/tmp/photos/result.png"}}}
{"id":"copy-1","result":{"bytesCopied":2097152}}
```

One request copies one regular file between `self` and `caller`. The controller transfers data in chunks. With a `write` grant it replaces the entire destination file. With only `create`, it opens a new name exclusively. The source is preserved. Copying a file onto itself returns an error. The `self` side uses the worker's own permissions. The path must be absolute and normalized with no symbolic links. The service trees `/proc`, `/dev`, `/sys` and `/run` are inaccessible.

## Streaming

```jsonl
{"id":"file-1","method":"files.open","params":{"callId":"call-58","path":"/tmp/photos/result.png","mode":"create"}}
{"id":"file-1","result":{"handle":"8b3915ca-bad7-40f5-9a93-c68d4b3fbd40"}}
```

In the sandbox, connect to the Unix socket at `/run/pappai/files`. For a trusted process the path is in `PAPPAI_FILES_SOCKET`. The protocol is HTTP/1.1. For `read`, request `GET /<handle>`. For `write` and `create`, send `PUT /<handle>` with a binary body and either a correct `Content-Length` or standard HTTP chunked encoding with the terminating zero-length chunk. A successful write returns HTTP 200 and JSON such as `{"bytesWritten":25401}`. A streaming write starts at offset zero. If the new data is shorter than the original file, the old trailing bytes remain.

```js
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function upload(handle, source) {
  const request = http.request({
    socketPath: process.env.PAPPAI_FILES_SOCKET || '/run/pappai/files',
    method: 'PUT', path: '/' + handle
  });
  const result = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', async response => {
      try {
        let text = '';
        for await (const part of response) text += part;
        if (response.statusCode !== 200) throw Error('File rejected: ' + response.statusCode);
        resolve(JSON.parse(text));
      } catch (error) { reject(error); }
    });
  });
  const [, receipt] = await Promise.all([pipeline(createReadStream(source), request), result]);
  return receipt;
}
```

A handle is single-use and works on the assigned worker's socket. Closing the call interrupts active streams and revokes unused handles. An unfinished write blocks a successful method reply. If an upload breaks off, finish the call with an error. Each call allows up to 32 concurrent handles and copy operations combined.
