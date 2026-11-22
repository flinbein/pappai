"""Offline Codex MCP inventory probe. Run inside a disposable Linux container."""
import concurrent.futures
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from endpoints import NAMES, url


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.contacted.set()
        self.send_error(405)

    do_DELETE = do_GET

    def do_POST(self):
        name = self.path.strip("/")
        self.server.contacted.set()
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = msg.get("method")
        if method == "initialize":
            result = {"protocolVersion": msg["params"]["protocolVersion"],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": name, "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": name, "inputSchema": {"type": "object"}}]}
        elif "id" not in msg:
            self.send_response(202)
            self.end_headers()
            return
        else:
            result = {}
        data = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def inventory(executable, home, workspace):
    # An ephemeral working directory and a minimal environment prevent reading a real account.
    env = {"HOME": str(home.parent), "CODEX_HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin"}
    proc = subprocess.Popen([executable, "app-server", "--listen", "stdio://"], cwd=workspace, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    messages = queue.Queue()

    def listen():
        for line in proc.stdout:
            messages.put(json.loads(line))
        messages.put(None)

    threading.Thread(target=listen, daemon=True).start()

    def rpc(method, params, request_id=None):
        payload = {"method": method, "params": params}
        if request_id is not None:
            payload["id"] = request_id
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()
        if request_id is not None:
            while True:
                response = messages.get(timeout=25)
                if response is None:
                    raise RuntimeError("app-server exited while handling " + method)
                if response.get("id") == request_id:
                    if "error" in response:
                        raise RuntimeError(response["error"])
                    return response["result"]

    try:
        rpc("initialize", {"clientInfo": {"name": "pappai_probe", "version": "1"},
                           "capabilities": {"experimentalApi": True}}, 1)
        rpc("initialized", {})
        # A mock provider is configured just to permit starting a thread offline.
        # No turns or tools are invoked.
        thread = rpc("thread/start", {"cwd": str(workspace), "ephemeral": True}, 2)["thread"]["id"]
        data = rpc("mcpServerStatus/list", {"threadId": thread, "detail": "toolsAndAuthOnly"}, 3)["data"]
        return {row["name"] for row in data if row.get("tools")}
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main(executable, mode, member=None):
    if mode not in ("control", "managed", "localOnly", "offline"):
        raise ValueError("unknown test mode")
    if mode in ("managed", "localOnly") and member not in ("a", "b"):
        raise ValueError("mount the policy for the indicated APP")
    system_policy = Path("/etc/codex/requirements.toml")
    if system_policy.exists() != (mode != "control"):
        raise RuntimeError("unexpected fixture policy; use a fresh container")
    # A separate origin per MCP attributes even OAuth discovery at /.well-known.
    servers = {}
    for name in NAMES:
        http = ThreadingHTTPServer(("127.0.0.1", urlparse(url(name)).port), Fixture)
        http.contacted = threading.Event()
        servers[name] = http
        threading.Thread(target=http.serve_forever, daemon=True).start()

    def endpoint(name):
        return f'[mcp_servers.{name}]\nurl = "{url(name)}"\n'

    def run(member):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home, workspace = root / "home", root / "workspace"
            home.mkdir()
            workspace.mkdir()
            (workspace / ".git").mkdir()
            (workspace / ".codex").mkdir()
            requested = {"profile_shared", "app_" + member}
            config = ('model_provider = "fixture"\n[model_providers.fixture]\nname="fixture"\n'
                      'base_url="http://127.0.0.1:19376/model"\nwire_api="responses"\n'
                      f'[projects.{json.dumps(str(workspace))}]\ntrust_level="trusted"\n')
            # A distinct unselected user entry and a trusted project entry test
            # the policy independently of the runner's materialized selection.
            (home / "config.toml").write_text(config + "".join(endpoint(n) for n in sorted(requested | {"user_fixture"})))
            other = "app_b" if member == "a" else "app_a"
            (workspace / ".codex" / "config.toml").write_text(endpoint("project_fixture") + endpoint(other))
            expected = requested | ({"user_fixture", "project_fixture", other} if mode == "control" else set())
            if mode == "offline":
                expected = set()
            if mode == "localOnly":
                expected = {"app_" + member}
            actual = inventory(executable, home, workspace)
            if actual != expected:
                raise AssertionError(f"{mode}/{member}: expected {sorted(expected)}, discovered {sorted(actual)}")
            print(mode, member, sorted(actual), flush=True)
            return expected

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            observed = list(pool.map(run, [member] if member else ["a", "b"]))
        contacts = {name for name, http in servers.items() if http.contacted.is_set()}
        if contacts != set.union(*observed):
            raise AssertionError(f"unexpected HTTP contacts: {sorted(contacts)}")
    finally:
        for http in servers.values():
            http.shutdown()
            http.server_close()


if __name__ == "__main__":
    main(*sys.argv[1:])
