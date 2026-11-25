#!/usr/bin/env python3
"""Run the two constraint switches on identical synthetic motion; no external service needed."""

import argparse
import copy
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCHMARK = HERE.parent
POSE = BENCHMARK.parent / "platform" / "web" / "pose.js"
PROFILE = HERE / "rig-profile.json"
sys.path.insert(0, str(BENCHMARK))
import motion  # The exact numerical evaluator used by the diagnostic workspace.

ACTIONS = ("idle", "nod", "wave")
VARIANTS = {"off": (False, False), "length": (True, False),
            "reconnect": (False, True), "both": (True, True)}
WINDOWS = {"idle": (121, 4.0), "nod": (85, 2.8), "wave": (109, 3.6)}
GENERATOR = """
import { pathToFileURL } from 'node:url';
const {createDemoTrace} = await import(pathToFileURL(process.argv[1]));
const action = process.argv[2];
console.log(JSON.stringify(['none','stretch','detach'].map(f => createDemoTrace(action,f))));
"""


def sha_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generated(action):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", GENERATOR, str(POSE), action],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def vadd(a, b):
    return [x + y for x, y in zip(a, b)]


def vsub(a, b):
    return [x - y for x, y in zip(a, b)]


def combined(clean, stretched, detached):
    # These two generator faults change scale and an additive child bind offset.
    # Both leave the orientation trajectory intact, so their point displacements add.
    result = copy.deepcopy(stretched)
    result["fault"] = "stretch+detach"
    for normal, offset, out in zip(clean["frames"], detached["frames"], result["frames"]):
        if normal["t"] != offset["t"] or normal["t"] != out["t"]:
            raise ValueError("source frame timestamps differ")
        for name, segment in out["bones"].items():
            for marker in ("head", "tail"):
                displacement = vsub(offset["bones"][name][marker], normal["bones"][name][marker])
                segment[marker] = vadd(segment[marker], displacement)
    return result


def topological(bones):
    remaining = {b["id"]: b for b in bones}
    ordered = []
    while remaining:
        ready = [b for b in remaining.values() if b["parent"] not in remaining]
        if not ready:
            raise ValueError("cyclic bone hierarchy")
        ordered.extend(ready)
        for bone in ready:
            del remaining[bone["id"]]
    return ordered


def repair(trace, profile, variant):
    """Translate each segment then correct its own terminal displacement; preserve orientation."""
    length_on, reconnect_on = VARIANTS[variant]
    result = copy.deepcopy(trace)
    result["repair"] = {"length": length_on, "reconnect": reconnect_on,
                        "source_fault": trace["fault"], "method": "segment_translation_and_length_projection"}
    if not (length_on or reconnect_on):
        return result
    order = topological(profile["bones"])
    for original, output in zip(trace["frames"], result["frames"]):
        inputs, outputs = original["bones"], output["bones"]
        for bone in order:
            name, parent = bone["id"], bone["parent"]
            raw = inputs[name]
            delta = [0, 0, 0]
            if parent is not None:
                # Ancestor terminal displacement is inherited even with reconnection off.
                # With reconnection on, also remove the observed gap at this attachment.
                delta = vsub(outputs[parent]["tail"], inputs[parent]["tail"])
                if reconnect_on:
                    delta = vsub(delta, vsub(raw["head"], inputs[parent]["tail"]))
            head, tail = vadd(raw["head"], delta), vadd(raw["tail"], delta)
            if length_on:
                direction = vsub(raw["tail"], raw["head"])
                measured = math.hypot(*direction)
                if measured < 1e-10:
                    raise ValueError(f"undefined direction at {name}")
                tail = vadd(head, [x * bone["rest_length"] / measured for x in direction])
            outputs[name] = {"head": head, "tail": tail}
    return result


def compact(report):
    checks = report["checks"]
    return {
        "verdict": report["verdict"],
        "failed_checks": [k for k, c in checks.items() if c["verdict"] == "fail"],
        "abstained_checks": [k for k, c in checks.items() if c["verdict"] == "abstain"],
        "length_violations": checks["bone_length"]["violations"],
        "gap_violations": checks["joint_gap"]["violations"],
        "max_length_error_pct": round(checks["bone_length"]["worst"]["value"] * 100, 6),
        "max_gap_mm": round(checks["joint_gap"]["worst"]["value"] * 1000, 6),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="将本次汇总写入新的 JSON 文件")
    parser.add_argument("--export", nargs=3, metavar=("ACTION", "VARIANT", "TRACE_JSON"),
                        help="导出一份组合故障处理后的轨迹，例如 wave both /tmp/wave.json")
    args = parser.parse_args()
    if args.export and (args.export[0] not in ACTIONS or args.export[1] not in VARIANTS):
        parser.error("--export 要求 idle/nod/wave 和 off/length/reconnect/both")
    if args.export and args.out and args.out.resolve() == Path(args.export[2]).resolve():
        parser.error("--out 和 --export 需要不同路径")
    try:
        export_path = Path(args.export[2]) if args.export else None
        for destination in (args.out, export_path):
            if destination is not None and (destination.exists() or destination.is_symlink()):
                raise ValueError(f"输出已存在，请选择新路径：{destination}")
        export_trace = None
        profile = json.loads(PROFILE.read_text())
        if profile.get("connection_default") != "coincident" or any("connection" in b for b in profile["bones"]):
            raise ValueError("This experiment is calibrated only for the all-coincident demo rig.")
        summary = {
            "experiment": "Synthetic segment length projection × parent-child reconnection",
            "design": "One deterministic rig, three related clips, one identical corrupted input per action for all four cells. Descriptive checks on supplied samples only.",
            "controls": "Same source frames, fixed camera-independent coordinates, evaluator, geometry thresholds, fps and authored clip windows. No tuning on candidates.",
            "cells": {k: {"length": v[0], "reconnect": v[1]} for k, v in VARIANTS.items()},
            "scope_limits": [
                "Both constraints are provided by construction. Tests measure numerical satisfaction after repair, not independent physical recovery.",
                "Endpoint checks cannot observe axial twist, skin deformation, interpenetration, silhouette identity, or naturalness.",
                "These are three clips on one synthetic mannequin, not three independent characters or a human-motion quality study."
            ],
            "files_sha256": {"pose.js": sha_file(POSE), "rig-profile.json": sha_file(PROFILE),
                             "repair_ablation.py": sha_file(Path(__file__)),
                             "motion.py": sha_file(BENCHMARK / "motion.py")},
            "actions": {},
        }
        for action in ACTIONS:
            clean, stretch, detach = generated(action)
            count, end = WINDOWS[action]
            if any(len(t["frames"]) != count for t in (clean, stretch, detach)):
                raise ValueError(f"{action} frame count differs from authored clip")
            raw = combined(clean, stretch, detach)
            # The expected window is fixed by the authored clip specification, not by candidate duration.
            config = dict(profile, window_s=[0, end])
            clean_values = compact(motion.analyze(clean, config))
            clean_output = repair(clean, profile, "both")
            control_delta = max(math.dist(b[key], fb["bones"][name][key])
                                for fa, fb in zip(clean["frames"], clean_output["frames"])
                                for name, b in fa["bones"].items() for key in ("head", "tail"))
            run = {
                "frames": count, "duration_s": end, "input_sha256": motion.digest(raw),
                "clean_control": clean_values,
                "clean_with_both": {"verdict": motion.analyze(clean_output, config)["verdict"],
                                    "max_marker_displacement_mm": round(1000 * control_delta, 8)},
                "variants": {},
            }
            summary["actions"][action] = run
            for variant in VARIANTS:
                candidate = repair(raw, profile, variant)
                run["variants"][variant] = compact(motion.analyze(candidate, config))
                if args.export and [action, variant] == args.export[:2]:
                    export_trace = candidate
        if export_path:
            with export_path.open("x", encoding="utf-8") as stream:
                stream.write(json.dumps(export_trace, separators=(",", ":"), allow_nan=False) + "\n")
        if args.out:
            with args.out.open("x", encoding="utf-8") as stream:
                stream.write(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
        print("action   variant       verdict  max length (%)   max gap (mm)")
        for action, row in summary["actions"].items():
            for variant, result in row["variants"].items():
                print(f"{action:8} {variant:13} {result['verdict']:7} "
                      f"{result['max_length_error_pct']:13.6f} {result['max_gap_mm']:14.6f}")
        if args.out:
            print(args.out)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
