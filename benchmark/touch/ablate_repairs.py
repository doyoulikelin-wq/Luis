"""Run the two touch repairs independently against the same browser challenges."""
import argparse
import functools
import gzip
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
WINDOW = Path("platform/web/window")
BASELINE = "dbb9a1536bb0a42d92ec18b120cf0f3337be5891"
CASES = (
    "navigate-back-during-contact", "persisted-page-only-no-release", "navigate-back-after-release",
    "missing-up-and-capture-loss", "missing-up", "idle-after-lost-release",
    "stationary-drag-keeps-owner", "restored-touch-ownership", "restored-release-with-lost-terminals",
    "touchend-before-pointerup",
)
VARIANTS = {
    "baseline": None, "off": (False, False), "return-only": (True, False),
    "release-only": (False, True), "combined": (True, True),
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def prepare(folder, variant):
    target = folder / WINDOW
    if variant == "baseline":
        names = subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", BASELINE, str(WINDOW)], cwd=ROOT, text=True)
        for name in names.splitlines():
            out = folder / name
            out.parent.mkdir(exist_ok=True, parents=True)
            out.write_bytes(subprocess.check_output(["git", "show", f"{BASELINE}:{name}"], cwd=ROOT))
        return
    shutil.copytree(ROOT / WINDOW, target)
    # The combined cell serves production bytes, including the normal default options.
    if variant == "combined":
        return
    return_fix, release_fix = VARIANTS[variant]
    options = json.dumps({"returnRecovery": return_fix, "releaseRecovery": release_fix})
    entry = target / "main.js"
    source = entry.read_text()
    call = "connectInteraction(surface, showGesture)"
    if source.count(call) != 1:
        raise ValueError("Cannot isolate the two repairs in this version of main.js")
    entry.write_text(source.replace(call, f"connectInteraction(surface, showGesture, {options})"))


def run(variant, repeat, output):
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        prepare(folder, variant)
        handler = functools.partial(QuietHandler, directory=str(folder))
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/{WINDOW.as_posix()}/"
                evidence_path = folder / "run.json"
                process = subprocess.run([
                    "node", "benchmark/touch/run.mjs", "--suite", "lifecycle,contacts,repairs",
                    "--case", ",".join(CASES), "--repeat", str(repeat), "--out", str(evidence_path),
                ], cwd=ROOT, env={**os.environ, "LUIS_WINDOW_URL": url}, check=False)
                if process.returncode not in (0, 1) or not evidence_path.is_file():
                    raise RuntimeError(f"Runner failed for {variant}: exit {process.returncode}")
                report = json.loads(evidence_path.read_bytes())
                expected = {(case, i) for case in CASES for i in range(1, repeat + 1)}
                if {(r["id"], r["iteration"]) for r in report["results"]} != expected:
                    raise RuntimeError(f"Incomplete evidence for {variant}")
                report["variant"] = variant
                report["baselineRef"] = BASELINE
                report["repairOptions"] = VARIANTS[variant]
                encoded = (json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                (output / f"{variant}.json.gz").write_bytes(gzip.compress(encoded, mtime=0))
                print(variant, report["counts"], flush=True)
                return report
            finally:
                server.shutdown()
                thread.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=VARIANTS, action="append", help="Default: run all five cells")
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    args.out.mkdir(exist_ok=True, parents=True)
    reports = [run(name, args.repeat, args.out) for name in dict.fromkeys(args.variant or VARIANTS)]
    if any(r["counts"]["unverified"] or r["counts"]["error"] for r in reports):
        return 2
    return int(any(r["variant"] == "combined" and r["counts"]["fail"] for r in reports))


if __name__ == "__main__":
    raise SystemExit(main())
