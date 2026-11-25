# Browse files as a USER

After signing in, choose **Files** in the sidebar or open `/files/` on the panel host. The controller serves each directory as a page of links. Regular files, including HTML files, are available for download. A panel script can use `fetch` with the same session.

```js
const response = await fetch('/files/workspace/reports/today.txt');
if (response.ok) {
  const path = decodeURIComponent(response.headers.get('X-Pappai-File-Path'));
  console.log(path, await response.text());
}
```

The browser shows branches accessible through the USER's own permissions, ancestors or TEAM memberships. When only one file is allowed, its path is visible from the root. Intermediate pages list only names leading to existing authorized objects. Accessible physical directories also list symbolic links. When following one, the server checks access to both the requested name and the target.

For a sandboxed USER, `/tmp` maps to their private directory. An unrestricted USER sees the container's temporary directory. The trees `/proc`, `/dev`, `/sys` and `/run` are closed. A denied path returns `403`. An allowed but missing object returns `404`. An invalid path returns `400`. Environment preparation or read failures can return a server error.

The server checks permissions for each request. A download already in progress can finish after a permission change or session termination. See [delegated file access](delegated-files.md) for passing files between APPs.
