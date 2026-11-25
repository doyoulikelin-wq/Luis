#!/usr/bin/env python3
"""Compare paired evidence-based assessments without treating missing evidence as a verdict."""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


DIMENSIONS = ("visual", "motion", "persona", "memory", "creation", "runtime")
SPLITS = ("dev", "holdout")
VERDICTS = ("pass", "fail", "abstain")
DECIDED = ("pass", "fail")
UNDECIDED = ("missing", "abstain", "insufficient")
DEFAULT_CASES = Path(__file__).resolve().with_name("cases.jsonl")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def nonblank(value):
    return isinstance(value, str) and bool(value.strip())


def validate_case(row):
    for key in ("group", "axis", "criterion"):
        require(nonblank(row.get(key)), f"{key} 必须是非空字符串")
    require(row.get("dimension") in DIMENSIONS, f"dimension 应取自 {', '.join(DIMENSIONS)}")
    require(row.get("split") in SPLITS, f"split 应取自 {', '.join(SPLITS)}")
    require(isinstance(row.get("hard"), bool), "hard 必须是布尔值")
    keys = row.get("evidence_required")
    require(isinstance(keys, list) and keys and all(nonblank(key) for key in keys),
            "evidence_required 至少需要一个非空证据键")
    require(len(keys) == len(set(keys)), "evidence_required 含重复字段")


def validate_result(row, cases):
    require(row["id"] in cases, f"未知 id {row['id']!r}")
    require(row.get("verdict") in VERDICTS, f"verdict 应取自 {', '.join(VERDICTS)}")
    # status() counts incomplete determinate decisions as insufficient.
    for key in ("reviewer_config_hash", "case_sha256", "evidence_sha256", "run_id"):
        require(key not in row or nonblank(row[key]), f"{key} 必须是非空字符串")
    if "evidence_sha256" in row:
        require(re.fullmatch(r"[0-9a-f]{64}", row["evidence_sha256"]),
                "evidence_sha256 必须是 64 位小写十六进制 SHA-256")
    check_case_fingerprint(cases[row["id"]], row)


def check_case_fingerprint(case, row):
    if "case_sha256" in row:
        canonical = json.dumps(case, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        require(row["case_sha256"] == expected,
                f"{case['id']} 的 case_sha256 与当前用例不符")


def load_rows(path, check):
    rows = {}
    with Path(path).open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                require(isinstance(row, dict), "每行必须是 JSON 对象")
                require(nonblank(row.get("id")), "id 必须是非空字符串")
                require(row["id"] not in rows, f"重复 id {row['id']!r}")
                check(row)
            except ValueError as error:
                raise ValueError(f"{path} 第 {line_number} 行：{error}") from error
            rows[row["id"]] = row
    return rows


def load_cases(path):
    cases = load_rows(path, validate_case)
    require(cases, f"{path} 没有用例")
    splits = {}
    for case in cases.values():
        group, split = case["group"], case["split"]
        require(splits.setdefault(group, split) == split,
                f"{path} 的组 {group!r} 同时出现于 dev 和 holdout")
    return cases


def status(case, results):
    result = results.get(case["id"])
    if result is None:
        return "missing"
    if result["verdict"] == "abstain":
        return "abstain"
    evidence = result.get("evidence", {})
    if not nonblank(result.get("note")) or not isinstance(evidence, dict):
        return "insufficient"
    if set(evidence) != set(case["evidence_required"]):
        return "insufficient"
    if not all(valid_locator(value) for value in evidence.values()):
        return "insufficient"
    return result["verdict"]


def valid_locator(value):
    if not nonblank(value):
        return False
    first = re.split(r"[|｜：:，,\s]", value.strip().casefold(), maxsplit=1)[0]
    return first not in {"n/a", "na", "none", "null", "unknown", "missing", "tbd",
                         "todo", "placeholder", "<ref>", "<locator>", "-", "—", "缺失",
                         "无", "未知", "待补", "未提供", "不可访问", "无法访问", "占位",
                         "pass", "fail", "true", "false", "ok", "通过", "失败"}


def check_pair_identity(cases, first, second, *, calibration=False):
    keys = ("evidence_sha256", "run_id") if calibration else ("reviewer_config_hash",)
    for records in (first, second):
        run_ids = {row["run_id"] for row in records.values() if "run_id" in row}
        require(len(run_ids) <= 1, f"单侧结果文件混入多个 run_id：{sorted(run_ids)}")
    for case in cases:
        case_id = case["id"]
        a, b = first.get(case_id, {}), second.get(case_id, {})
        check_case_fingerprint(case, a)
        check_case_fingerprint(case, b)
        for key in keys:
            if key in a and key in b:
                require(a[key] == b[key], f"{case_id} 两侧的 {key} 不同，无法比较")


def report_provenance(records, label, calibration):
    fields = ["case_sha256", "run_id"]
    fields.append("evidence_sha256" if calibration else "reviewer_config_hash")
    run = next((row["run_id"] for row in records.values() if "run_id" in row), None)
    if run is not None:
        print(f"{label}运行编号：{run}")
    gaps = []
    for field in fields:
        absent = sum(field not in row for row in records.values())
        if absent:
            gaps.append(f"{field} 缺 {absent}/{len(records)} 行")
    if gaps:
        print(f"来源核验不完整（{label}）：{'，'.join(gaps)}。相应来源需人工核对。")
    if any("evidence_sha256" not in row for row in records.values()):
        print(f"证据核验提示（{label}）：有记录未绑定原始证据指纹，定位字符串须回到原始材料复核。")


def by_field(rows, key):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row[0][key]].append(row)
    return grouped


def covered(statuses):
    return statuses["pass"] + statuses["fail"]


def fraction(numerator, denominator):
    return f"{numerator}/{denominator}" if denominator else "— (0/0)"


def hard_ids(rows, which, wanted):
    return ", ".join(f"{case['id']}({pair[which]})" for case, *pair in rows
                     if case["hard"] and pair[which] in wanted) or "无"


def pair_counts(rows):
    counts = Counter()
    for _, base, cand in rows:
        if base not in DECIDED or cand not in DECIDED:
            counts["unpaired"] += 1
        elif base == cand:
            counts["tie"] += 1
        elif cand == "pass":
            counts["win"] += 1
        else:
            counts["loss"] += 1
    return counts


def compare_row(label, rows):
    base = Counter(b for _, b, _ in rows)
    cand = Counter(c for _, _, c in rows)
    pairs = pair_counts(rows)
    n = len(rows)
    print(label, n, fraction(base["pass"], n), fraction(cand["pass"], n),
          fraction(covered(base), n), fraction(covered(cand), n),
          fraction(n - pairs["unpaired"], n), pairs["win"], pairs["loss"], pairs["tie"],
          sep="\t")


def compare(rows):
    print("检查点\t总数\t基线通过\t候选通过\t基线覆盖\t候选覆盖\t可比配对\t候选胜\t候选负\t平")
    compare_row("合计", rows)
    dimensions = by_field(rows, "dimension")
    for name in DIMENSIONS:
        if name in dimensions:
            compare_row(name, dimensions[name])
    for index, label in enumerate(("基线", "候选")):
        counts = Counter(row[index + 1] for row in rows)
        print(f"{label}未判：missing={counts['missing']} abstain={counts['abstain']} "
              f"insufficient={counts['insufficient']}")
        print(f"{label}硬项失败：{hard_ids(rows, index, ('fail',))}")
        print(f"{label}硬项未判：{hard_ids(rows, index, UNDECIDED)}")

    groups = by_field(rows, "group")
    outcomes = Counter()
    print("\n素材／对话组\t检查点\t可比配对\t胜\t负\t平\t组结果")
    for name, items in groups.items():
        p = pair_counts(items)
        if p["unpaired"]:
            outcome = "未判"
        elif p["win"] > p["loss"]:
            outcome = "胜"
        elif p["loss"] > p["win"]:
            outcome = "负"
        else:
            outcome = "平"
        outcomes[outcome] += 1
        print(name, len(items), fraction(len(items) - p["unpaired"], len(items)),
              p["win"], p["loss"], p["tie"], outcome, sep="\t")
    print(f"独立组数={len(groups)}。组内所有检查点双边可判时按通过数比较，每组一票。"
          f"候选胜={outcomes['胜']} 负={outcomes['负']} 平={outcomes['平']} 未判={outcomes['未判']}")


def calibration_row(label, rows):
    eligible = [row for row in rows if row[1] in DECIDED]
    gold = Counter(g for _, g, _ in eligible)
    ai = Counter(a for _, _, a in eligible)
    false_pass = sum(g == "fail" and a == "pass" for _, g, a in eligible)
    false_fail = sum(g == "pass" and a == "fail" for _, g, a in eligible)
    print(label, fraction(len(eligible), len(rows)), fraction(covered(ai), len(eligible)),
          fraction(false_pass, gold["fail"]), fraction(false_fail, gold["pass"]),
          ai["abstain"], ai["missing"], ai["insufficient"], sep="\t")


def calibrate(rows):
    print("检查点\t有效金标/全量\tAI覆盖/有效金标\t错放/金标失败\t错杀/金标通过\tAI弃权\tAI缺行\tAI证据不足")
    calibration_row("合计", rows)
    dimensions = by_field(rows, "dimension")
    for name in DIMENSIONS:
        if name in dimensions:
            calibration_row(name, dimensions[name])
    gold = Counter(g for _, g, _ in rows)
    print(f"排除的金标：missing={gold['missing']} abstain={gold['abstain']} "
          f"insufficient={gold['insufficient']}")
    eligible = [row for row in rows if row[1] in DECIDED]
    gold_fail = [row for row in eligible if row[1] == "fail"]
    print(f"硬项错放：{hard_ids(gold_fail, 1, ('pass',))}")
    print(f"有效金标上的硬项 AI 未判：{hard_ids(eligible, 1, UNDECIDED)}")
    print(f"硬项金标未判：{hard_ids(rows, 0, UNDECIDED)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="用例 JSONL")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "compare", "calibrate"):
        sub = commands.add_parser(name)
        sub.add_argument("--cases", type=Path, default=argparse.SUPPRESS, help="用例 JSONL")
        if name == "validate":
            continue
        sub.add_argument("first", type=Path, metavar="BASE" if name == "compare" else "GOLD")
        sub.add_argument("second", type=Path, metavar="CAND" if name == "compare" else "AI")
        sub.add_argument("--split", choices=SPLITS, required=True)
    args = parser.parse_args()
    try:
        cases = load_cases(args.cases)
        if args.command == "validate":
            for split in SPLITS:
                selected = [c for c in cases.values() if c["split"] == split]
                print(f"{split}：{len(selected)} 个检查点，{len({c['group'] for c in selected})} 个独立组")
            return 0
        first, second = (load_rows(path, lambda row: validate_result(row, cases))
                         for path in (args.first, args.second))
        selected = [c for c in cases.values() if c["split"] == args.split]
        require(selected, f"{args.cases} 没有 {args.split} 用例")
        calibration = args.command == "calibrate"
        check_pair_identity(selected, first, second, calibration=calibration)
        rows = [(c, status(c, first), status(c, second)) for c in selected]
        print(f"split={args.split}")
        labels = ("人工金标", "AI 审核") if calibration else ("基线", "候选")
        for records, label in zip((first, second), labels):
            report_provenance(records, label, calibration)
        if args.command == "compare":
            compare(rows)
        else:
            calibrate(rows)
        return 0
    except (OSError, ValueError) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
