"""Synthetic geometric controls; no learned judge, GPU or captured performance is used."""
import copy
import math
import unittest

from motion import DEMO_LIMITS, analyze


def arm(flexion=30.0, count=8, fps=30.0):
    """Two independent marker pairs in the metric avatar frame."""
    frames = []
    rad = math.radians(flexion)
    for i in range(count):
        frames.append(dict(t=i / fps, bones={
            "upper": dict(head=[0, 0, 0], tail=[0.30, 0, 0]),
            "lower": dict(head=[0.30, 0, 0], tail=[0.30 + 0.25 * math.cos(rad), 0.25 * math.sin(rad), 0]),
        }))
    return dict(schema="luis.motion-trace.v1", units="m", space="avatar_local", fps=fps,
                action="synthetic", fault="hidden_label", anchors="independent_segment_markers",
                connection_default="coincident",
                bones=[dict(id="upper", parent=None, rest_length=0.30),
                       dict(id="lower", parent="upper", rest_length=0.25)],
                joints=[dict(id="elbow", parent="upper", child="lower", angle_deg=[0, 150])],
                limits=dict(DEMO_LIMITS), frames=frames)


def fixed(trace):
    return {key: copy.deepcopy(trace[key])
            for key in ("fps", "anchors", "connection_default", "bones", "joints", "limits")}


class MotionControls(unittest.TestCase):
    def test_clean_and_blind_label(self):
        trace = arm()
        self.assertEqual(analyze(trace)["verdict"], "pass")
        trace["fault"] = "detached"
        self.assertEqual(analyze(trace)["verdict"], "pass")

    def test_frozen_calibration_detects_constant_stretch_from_first_frame(self):
        trace = arm(0); reference = fixed(trace)
        for frame in trace["frames"]:
            frame["bones"]["lower"]["tail"][0] += 0.05
        trace["bones"][1]["rest_length"] = 0.30
        trace["limits"]["length_rel"] = 1.0
        result = analyze(trace, reference)
        self.assertEqual(result["calibration_source"], "external_profile")
        self.assertEqual(result["checks"]["bone_length"]["verdict"], "fail")
        self.assertAlmostEqual(result["checks"]["bone_length"]["worst"]["value"], 0.20)

    def test_rigid_disconnection_with_normal_lengths(self):
        trace = arm()
        for frame in trace["frames"]:
            for p in frame["bones"]["lower"].values():
                p[2] += 0.03
        result = analyze(trace)["checks"]
        self.assertEqual(result["bone_length"]["verdict"], "pass")
        self.assertEqual(result["joint_gap"]["verdict"], "fail")
        self.assertAlmostEqual(result["joint_gap"]["worst"]["value"], 0.03)

    def test_offset_without_socket_or_unspecified_connection_is_undecidable(self):
        trace = arm()
        profile = fixed(trace)
        for frame in trace["frames"]:
            for p in frame["bones"]["lower"].values():
                p[2] += 0.03
        for spec in ({"kind": "unobserved"}, {"kind": "offset_socket"},
                     {"kind": "offset_socket", "parent_socket": "hand_mount"}):
            profile["bones"][1]["connection"] = spec
            report = analyze(trace, profile)
            self.assertEqual(report["checks"]["joint_gap"]["verdict"], "abstain")
            self.assertEqual(report["checks"]["joint_gap"]["violations"], 0)
            self.assertEqual(report["verdict"], "abstain")
        del profile["bones"][1]["connection"]
        del profile["connection_default"]
        self.assertEqual(analyze(trace, profile)["verdict"], "abstain")

    def test_authored_offset_socket_tracks_parent_separately(self):
        trace = arm()
        profile = fixed(trace)
        profile["bones"][1]["connection"] = {"kind": "offset_socket", "parent_socket": "mount"}
        for frame in trace["frames"]:
            frame["bones"]["upper"]["sockets"] = {"mount": [0.30, 0.0, 0.05]}
            for p in frame["bones"]["lower"].values():
                p[2] += 0.05
        self.assertEqual(analyze(trace, profile)["verdict"], "pass")
        frame = trace["frames"][-1]
        for p in frame["bones"]["lower"].values():
            p[2] += 0.03
        checks = analyze(trace, profile)["checks"]
        self.assertEqual(checks["joint_gap"]["verdict"], "fail")
        self.assertAlmostEqual(checks["joint_gap"]["worst"]["value"], 0.03)
        self.assertEqual(checks["bone_length"]["verdict"], "pass")

    def test_rigid_edges_and_unobserved_attachment_share_a_hierarchy(self):
        trace = arm()
        trace["bones"].append(dict(id="sleeve", parent="upper", rest_length=0.10,
                                   connection={"kind":"unobserved"}))
        for frame in trace["frames"]:
            frame["bones"]["sleeve"] = {"head": [0, 0.1, 0], "tail": [0, 0.2, 0]}
        report = analyze(trace)
        gap = report["checks"]["joint_gap"]
        self.assertEqual((gap["observed"], gap["missing"], gap["violations"]), (8, 8, 0))
        self.assertEqual((gap["verdict"], report["verdict"]), ("abstain", "abstain"))

    def test_shared_or_missing_markers_cannot_certify_connectivity(self):
        trace = arm()
        for anchor_mode in ("shared_joint_samples", None):
            trace["anchors"] = anchor_mode
            self.assertEqual(analyze(trace)["checks"]["joint_gap"]["verdict"], "abstain")
        trace = arm()
        del trace["frames"][0]["bones"]["lower"]["head"]
        self.assertEqual(analyze(trace)["checks"]["joint_gap"]["verdict"], "abstain")

    def test_joint_limit_and_temporal_jump(self):
        self.assertEqual(analyze(arm(175))["checks"]["joint_flexion"]["verdict"], "fail")
        trace = arm(0)
        trace["frames"][-1]["bones"] = arm(90)["frames"][0]["bones"]
        result = analyze(trace)["checks"]
        self.assertEqual(result["angular_speed"]["verdict"], "fail")
        self.assertEqual(result["endpoint_speed"]["verdict"], "fail")
        self.assertEqual(result["angular_speed"]["worst"]["frame"], 7)

    def test_missing_midframe_and_ended_early_abstain(self):
        trace = arm()
        del trace["frames"][3]
        result = analyze(trace)
        self.assertEqual(result["checks"]["sample_interval"]["verdict"], "fail")
        self.assertEqual(result["checks"]["angular_speed"]["verdict"], "abstain")
        self.assertEqual(result["verdict"], "abstain")
        trace = arm()
        p = fixed(trace); p["window_s"] = [0.0, 1.0]
        self.assertEqual(analyze(trace, p)["verdict"], "abstain")

    def test_no_velocity_bridge_across_clock_gap_and_other_violations_retained(self):
        trace = arm(0, count=8)
        for frame in trace["frames"][4:]:
            frame["bones"] = arm(90, count=1)["frames"][0]["bones"]
        del trace["frames"][3]
        report = analyze(trace)
        self.assertEqual(report["intervals"], dict(adjacent=6, valid=5, skipped=1))
        for key, n in (("endpoint_speed", 20), ("angular_speed", 5)):
            check = report["checks"][key]
            self.assertEqual((check["observed"], check["verdict"]), (n, "abstain"))
            self.assertAlmostEqual(check["worst"]["value"], 0)
        self.assertEqual(report["verdict"], "abstain")
        trace["frames"][-1]["bones"] = arm(0, count=1)["frames"][0]["bones"]
        report = analyze(trace)
        for key in ("endpoint_speed", "angular_speed"):
            self.assertEqual(report["checks"][key]["verdict"], "fail")
            self.assertEqual(report["checks"][key]["worst"]["frame"], 6)
        self.assertEqual(report["verdict"], "fail")

    def test_bad_clock_or_absent_calibration(self):
        trace = arm()
        trace["frames"][2]["t"] = None
        self.assertEqual(analyze(trace)["verdict"], "abstain")
        trace = arm()
        trace["frames"][2]["t"] = 0
        self.assertEqual(analyze(trace)["verdict"], "abstain")
        profile = fixed(arm())
        del profile["anchors"]
        self.assertEqual(analyze(arm(), profile)["checks"]["joint_gap"]["verdict"], "abstain")
        del profile["limits"]["gap_m"]
        with self.assertRaises(ValueError):
            analyze(arm(), profile)

    def test_external_profile_cannot_lose_declared_bone_or_inherit_candidate(self):
        trace = arm()
        profile = fixed(trace)
        del trace["frames"][0]["bones"]["lower"]
        self.assertEqual(analyze(trace, profile)["checks"]["bone_length"]["verdict"], "abstain")
        del profile["joints"]
        self.assertEqual(analyze(arm(), profile)["checks"]["joint_flexion"]["verdict"], "abstain")
        del profile["bones"]
        self.assertEqual(analyze(arm(), profile)["verdict"], "abstain")


if __name__ == "__main__":
    unittest.main()
