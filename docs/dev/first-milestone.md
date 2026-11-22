# Verifying the first build

1. In an empty workspace, register the administrator with a passkey. Create a TEAM, a USER and a stopped APP with an inline manifest. Restart the controller and check that SQLite retained the tree and settings.
2. Start the APP and find `message.extractText` through `help`. Calling it with `{"text":"  Hello  "}` should return `"Hello"`. The runner delivers the request to a sandboxed one-shot process. [First call from the panel](../first-call.md)
3. Repeat the call as a USER without permission to invoke the method. The controller should reject the request before it reaches the runner.
4. Terminate the test runner host while one call is being processed and another is waiting. Both clients should receive an error, and the APP should enter `error`. Use the assignment count to verify that work was dispatched only once.

The browser test uses a separate container and a Chromium virtual authenticator. Isolation tests require Linux with permission to create bubblewrap namespaces. [Verification commands](README.md#build-verification) · [Browser scenario](../../tests/browser-acceptance.mjs) · [Runner crash test](../../tests/runner-loss.test.ts)
