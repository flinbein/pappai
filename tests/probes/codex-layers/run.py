"""Usage: python run.py /path/to/extracted/linux/vendor/x86_64-unknown-linux-musl IMAGE"""
import concurrent.futures
import subprocess
import sys
import tempfile
from pathlib import Path
from endpoints import url


def check(case):
    mode, member = case
    directory = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as temp:
        args = ["docker", "run", "--rm", "--network", "none",
                "--mount", f"type=bind,src={Path(sys.argv[1]).resolve()},dst=/opt/codex,readonly",
                "--mount", f"type=bind,src={directory},dst=/probe,readonly"]
        if mode != "control":
            policy = Path(temp) / "requirements.toml"
            names = ["profile_shared", "app_" + member] if member else []
            if mode == "localOnly":
                names = ["app_" + member]
            entries = [f'[mcp_servers.{n}.identity]\nurl = "{url(n)}"\n' for n in names]
            policy.write_text("".join(entries) or "[mcp_servers]\n")
            args.extend(["--mount", f"type=bind,src={policy},dst=/etc/codex/requirements.toml,readonly"])
        subprocess.run(args + [sys.argv[2], "python3", "/probe/check.py", "/opt/codex/bin/codex", mode]
                       + ([member] if member else []), check=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(check, [("control", None), ("managed", "a"), ("managed", "b"),
                              ("localOnly", "a"), ("offline", None)]))
