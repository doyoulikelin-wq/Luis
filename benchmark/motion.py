#!/usr/bin/env python3
"""Measure the sampled skeleton in a Luis v1 motion trace. Requires Python 3.8+."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path


# Engineering examples for the procedural demo, not population reference values.
DEMO_LIMITS = dict(length_rel=0.05, gap_m=0.01, angular_speed_deg_s=720.0,
                   endpoint_speed_m_s=6.0, max_frame_dt_s=0.08)
UNITS = dict(bone_length="ratio", joint_gap="m", joint_flexion="deg",
             endpoint_speed="m/s", angular_speed="deg/s", sample_interval="s")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def digest(obj):
    data = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


class Check:
    def __init__(self, unit):
        self.unit = unit
        self.observed = self.missing = self.violations = 0
        self.reasons = set()
        self.margin = -math.inf
        self.worst = None

    def skip(self, reason):
        self.missing += 1
        self.reasons.add(reason)

    def observe(self, value, lower, upper, target, frame, start, end):
        if not finite(value):
            self.skip("nonfinite_measurement")
            return
        margin = value - upper
        if lower is not None:
            margin = max(margin, lower - value)
        self.observed += 1
        if margin > 1e-9:
            self.violations += 1
        if margin > self.margin:
            self.margin = margin
            self.worst = dict(target=target, frame=frame, t_start=start, t_end=end,
                              value=value, lower=lower, upper=upper)

    def result(self):
        verdict = "fail" if self.violations else "pass"
        if not self.violations and (self.missing or not self.observed):
            verdict = "abstain"
        return dict(verdict=verdict, unit=self.unit, observed=self.observed,
                    missing=self.missing, violations=self.violations,
                    reasons=sorted(self.reasons), worst=self.worst)


def definitions(rows, field):
    if not isinstance(rows, list):
        raise ValueError(f"{field} must be an array")
    result = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
            raise ValueError(f"{field} entry needs an id")
        if row["id"] in result:
            raise ValueError(f"duplicate {field} id: {row['id']}")
        result[row["id"]] = row
    return result


def point(obj, key):
    v = obj.get(key) if isinstance(obj, dict) else None
    if isinstance(v, list) and len(v) == 3 and all(finite(x) for x in v):
        return v
    return None


def direction(head, tail):
    if head is None or tail is None:
        return None
    length = math.dist(head, tail)
    if length < 1e-9 or not finite(length):
        return None
    return tuple((t - h) / length for h, t in zip(head, tail))


def angle(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    return math.degrees(math.acos(max(-1.0, min(1.0, dot))))


def connection_specs(config, bones):
    default = config.get("connection_default", "unobserved")
    if default not in ("coincident", "unobserved"):
        raise ValueError("connection_default must be coincident or unobserved")
    specs = {}
    for name, bone in bones.items():
        if bone.get("parent") is None:
            continue
        spec = bone.get("connection", {"kind": default})
        if not isinstance(spec, dict) or spec.get("kind") not in ("coincident", "offset_socket", "unobserved"):
            raise ValueError(f"invalid connection for {name}")
        socket = spec.get("parent_socket")
        if socket is not None and (spec["kind"] != "offset_socket" or not isinstance(socket, str) or not socket.strip()):
            raise ValueError(f"invalid parent_socket for {name}")
        specs[name] = dict(kind=spec["kind"], parent_socket=socket)
    return specs


def analyze(trace, profile=None):
    if (trace.get("schema"), trace.get("units"), trace.get("space")) != (
            "luis.motion-trace.v1", "m", "avatar_local"):
        raise ValueError("expected luis.motion-trace.v1, units=m, space=avatar_local")
    if profile is not None and not isinstance(profile, dict):
        raise ValueError("profile must be an object")
    config = trace if profile is None else profile
    bones = definitions(config.get("bones", []), "bones")
    connections = connection_specs(config, bones)
    joints = definitions(config.get("joints", []), "joints")
    for bone in bones.values():
        parent = bone.get("parent")
        if parent is not None and (not isinstance(parent, str) or parent not in bones or parent == bone["id"]):
            raise ValueError(f"invalid parent of {bone['id']}")
        # Reject cycles even when all individual references exist.
        ancestors = {bone["id"]}
        while parent is not None:
            if not isinstance(parent, str) or parent not in bones:
                raise ValueError(f"unknown bone ancestor: {parent}")
            if parent in ancestors:
                raise ValueError("cycle in bone hierarchy")
            ancestors.add(parent)
            parent = bones[parent].get("parent")
    for j in joints.values():
        child, parent = j.get("child"), j.get("parent")
        bounds = j.get("angle_deg")
        if (not isinstance(child, str) or not isinstance(parent, str)
                or child not in bones or parent not in bones or bones[child].get("parent") != parent
                or not isinstance(bounds, list) or len(bounds) != 2
                or not all(finite(v) for v in bounds) or not 0 <= bounds[0] <= bounds[1] <= 180):
            raise ValueError(f"invalid joint definition: {j['id']}")
    limits = dict(DEMO_LIMITS)
    supplied = config.get("limits", {})
    if not isinstance(supplied, dict) or set(supplied) - set(limits):
        raise ValueError("unknown or malformed limits")
    if profile is not None and set(supplied) != set(DEMO_LIMITS):
        raise ValueError("external profile requires all five independent limits")
    limits.update(supplied)
    if any(not finite(v) or v < 0 for v in limits.values()) or limits["max_frame_dt_s"] <= 0:
        raise ValueError("invalid numeric limits")
    frames = trace.get("frames", [])
    if not isinstance(frames, list):
        raise ValueError("frames must be an array")
    checks = {key: Check(unit) for key, unit in UNITS.items()}
    fps = config.get("fps")
    interval_limit = limits["max_frame_dt_s"]
    known_fps = finite(fps) and fps > 0
    if known_fps:
        # A missing sample in a nominally uniform stream doubles its interval.
        interval_limit = min(interval_limit, 1.5 / fps)
    else:
        checks["sample_interval"].skip("nominal_fps_missing")
    window = config.get("window_s")
    if window is not None and (not isinstance(window, list) or len(window) != 2
                               or not all(finite(x) for x in window) or window[0] >= window[1]):
        raise ValueError("window_s must be [start,end] in seconds")
    independent = (trace.get("anchors") == "independent_segment_markers"
                   and config.get("anchors") == "independent_segment_markers")
    if not independent:
        checks["joint_gap"].skip("independent_segment_markers_required")
    if not joints:
        checks["joint_flexion"].skip("no_joint_angle_definition")
        checks["angular_speed"].skip("no_joint_angle_definition")
    previous_t, previous_points, previous_angles = None, {}, {}
    valid_intervals = 0
    incomplete_time = len(frames) < 2 or not known_fps
    if profile is not None and known_fps:
        reported_fps = trace.get("fps")
        if not finite(reported_fps) or not math.isclose(reported_fps, fps, rel_tol=1e-6):
            checks["sample_interval"].skip("capture_fps_differs_from_frozen_profile")
            incomplete_time = True
    if window is not None:
        bounds = [frames[i].get("t") if frames and isinstance(frames[i], dict) else None
                  for i in (0, -1)]
        if (not all(finite(v) for v in bounds) or bounds[0] > window[0] + 1e-8
                or bounds[1] < window[1] - 1e-8):
            checks["sample_interval"].skip("expected_window_not_covered")
            incomplete_time = True
    for i, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise ValueError(f"frame {i} must be an object")
        t = frame.get("t")
        if not finite(t):
            checks["sample_interval"].skip("missing_timestamp")
            incomplete_time = True
            previous_t, previous_points, previous_angles = None, {}, {}
            continue
        dt = t - previous_t if previous_t is not None else None
        successive = dt is not None and 0 < dt <= interval_limit + 1e-9
        if successive:
            valid_intervals += 1
        if dt is not None:
            if dt <= 0:
                checks["sample_interval"].skip("nonmonotonic_timestamps")
            else:
                checks["sample_interval"].observe(dt, None, interval_limit,
                                                  "clock", i, previous_t, t)
            incomplete_time |= not successive
        samples = frame.get("bones", {})
        if not isinstance(samples, dict):
            raise ValueError(f"frame {i} bones must be an object")
        points, axes, angles = {}, {}, {}
        for name, bone in bones.items():
            sample = samples.get(name)
            head, tail = point(sample, "head"), point(sample, "tail")
            axes[name] = direction(head, tail)
            rest = bone.get("rest_length")
            if not finite(rest) or rest <= 0:
                checks["bone_length"].skip("missing_positive_bind_length")
            elif head is None or tail is None:
                checks["bone_length"].skip("missing_segment_marker")
            else:
                change = abs(math.dist(head, tail) / rest - 1.0)
                checks["bone_length"].observe(change, None, limits["length_rel"], name, i, t, t)
            for side, coord in (("head", head), ("tail", tail)):
                key = (name, side)
                points[key] = coord
                if not successive:
                    continue
                old = previous_points.get(key)
                if old is None or coord is None:
                    checks["endpoint_speed"].skip("missing_adjacent_endpoint")
                else:
                    speed = math.dist(old, coord) / dt
                    checks["endpoint_speed"].observe(speed, None, limits["endpoint_speed_m_s"],
                                                     f"{name}.{side}", i, previous_t, t)
            parent = bone.get("parent")
            if independent and parent is not None:
                spec = connections[name]
                edge = f"{parent}->{name}"
                parent_sample = samples.get(parent)
                if spec["kind"] == "unobserved":
                    checks["joint_gap"].skip(f"no_observable_connection:{edge}")
                    continue
                if spec["kind"] == "offset_socket":
                    sockets = parent_sample.get("sockets") if isinstance(parent_sample, dict) else None
                    marker = point(sockets, spec["parent_socket"]) if spec["parent_socket"] else None
                    if marker is None:
                        checks["joint_gap"].skip(f"missing_independent_parent_socket:{edge}")
                        continue
                else:
                    marker = point(parent_sample, "tail")
                if head is None or marker is None:
                    checks["joint_gap"].skip(f"missing_parent_or_child_marker:{edge}")
                else:
                    gap = math.dist(marker, head)
                    checks["joint_gap"].observe(gap, None, limits["gap_m"], edge, i, t, t)
        for name, j in joints.items():
            a, b = axes[j["parent"]], axes[j["child"]]
            flexion = angle(a, b) if a is not None and b is not None else None
            angles[name] = flexion
            if flexion is None:
                checks["joint_flexion"].skip("missing_or_degenerate_segment")
            else:
                checks["joint_flexion"].observe(flexion, *j["angle_deg"], name, i, t, t)
            if successive:
                old = previous_angles.get(name)
                if old is None or flexion is None:
                    checks["angular_speed"].skip("missing_adjacent_flexion")
                else:
                    checks["angular_speed"].observe(abs(flexion - old) / dt, None,
                                                    limits["angular_speed_deg_s"], name, i, previous_t, t)
        previous_t, previous_points, previous_angles = t, points, angles
    if incomplete_time:
        for key in checks:
            if key != "sample_interval":
                checks[key].skip("insufficient_temporal_coverage")
    output = {key: value.result() for key, value in checks.items()}
    motion_verdicts = {row["verdict"] for key, row in output.items() if key != "sample_interval"}
    verdict = "fail" if "fail" in motion_verdicts else "abstain"
    if motion_verdicts == {"pass"} and output["sample_interval"]["verdict"] == "pass":
        verdict = "pass"
    effective = dict(bones=list(bones.values()), joints=list(joints.values()), limits=limits,
                     anchors=config.get("anchors", "unknown"), fps=fps, window_s=window,
                     connections=connections)
    intervals = max(len(frames) - 1, 0)
    return dict(schema="luis.motion-report.v1", verdict=verdict, frame_count=len(frames),
                calibration_source="external_profile" if profile is not None else "self_reported_demo",
                window_s=window, scope="provided_frames" if window is None else "provided_frames_with_expected_window",
                intervals=dict(adjacent=intervals, valid=valid_intervals, skipped=intervals-valid_intervals),
                anchors=trace.get("anchors", "unknown"), trace_sha256=digest(trace),
                profile_sha256=digest(effective), limits=limits, checks=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--profile", type=Path, help="separate fixed bones/joints/limits configuration")
    parser.add_argument("--out", type=Path, help="write JSON to a new file (default stdout)")
    args = parser.parse_args()
    try:
        trace = json.loads(args.trace.read_text(encoding="utf-8"))
        if not isinstance(trace, dict):
            raise ValueError("trace must be an object")
        profile = json.loads(args.profile.read_text(encoding="utf-8")) if args.profile else None
        data = json.dumps(analyze(trace, profile), ensure_ascii=False, indent=2, allow_nan=False)
        if args.out:
            with args.out.open("x", encoding="utf-8") as out:
                out.write(data + "\n")
        else:
            print(data)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"motion: {exc}\n")


if __name__ == "__main__":
    main()
