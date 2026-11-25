#!/usr/bin/env python3
"""Check declared experiment controls and describe a four-way paired comparison."""

import argparse
import itertools
import json
import sys
from pathlib import Path

import bench


DEFAULT_PLAN = Path(__file__).resolve().with_name("plans.json")
CELLS = ("A0", "A1", "B0", "B1")
MISSING = object()


def merge(defaults, overrides):
    config = defaults.copy()
    for key, value in overrides.items():
        if isinstance(config.get(key), dict) and isinstance(value, dict):
            config[key] = merge(config[key], value)
        else:
            config[key] = value
    return config


def show(value):
    if value is MISSING:
        return "（未设置）"
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def differences(a, b, path=()):
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            yield from differences(a.get(key, MISSING), b.get(key, MISSING), (*path, key))
    elif show(a) != show(b):
        yield path, a, b


def config(plan, name):
    runs = plan["runs"]
    bench.require(name in runs and isinstance(runs[name], dict), f"运行 {name!r} 缺失或格式不正确")
    return merge(plan["shared"], runs[name])


def check(plan, left, right, expected_key=None):
    changes = list(differences(config(plan, left), config(plan, right)))
    description = "；".join(f"{'.'.join(path)} {show(old)} → {show(new)}"
                           for path, old, new in changes)
    bench.require(len(changes) == 1, f"{left} 与 {right} 有 {len(changes)} 处差异。{description}")
    if expected_key is not None:
        bench.require(changes[0][0] == (expected_key,),
                      f"{left} 与 {right} 应仅改变 {expected_key}，实际为 {description}")
    return description


def interaction(args, plan):
    for left, right, key in (("A0", "A1", "identity_feature_node"),
                             ("B0", "B1", "identity_feature_node"),
                             ("A0", "B0", "generation_model"),
                             ("A1", "B1", "generation_model")):
        check(plan, left, right, key)
    ref = config(plan, "A0")
    bench.require(ref.get("identity_feature_node") is False and
                  config(plan, "A1").get("identity_feature_node") is True,
                  "节点状态必须为 A0/B0=false，A1/B1=true")
    seeds = ref.get("seeds")
    bench.require(isinstance(seeds, list) and len(seeds) == 1, "四组文件需绑定同一单个种子")
    split_cases = ref.get("case_ids_by_split")
    bench.require(isinstance(split_cases, dict), "计划需声明 case_ids_by_split")
    ids = split_cases.get(args.split)
    bench.require(isinstance(ids, list) and ids and all(bench.nonblank(i) for i in ids),
                  f"计划未列出 {args.split} 的有效检查点 ID")
    bench.require(len(ids) == len(set(ids)), "计划的检查点有重复 ID")
    cases = bench.load_cases(args.cases)
    bench.require(all(i in cases and cases[i]["split"] == args.split for i in ids),
                  f"计划含用例表 {args.split} 以外的检查点")
    selected = [cases[i] for i in ids]
    results = [bench.load_rows(getattr(args, cell), lambda r: bench.validate_result(r, cases))
               for cell in CELLS]
    for first, second in itertools.combinations(results, 2):
        bench.check_pair_identity(selected, first, second)

    grouped = {}
    for case in selected:
        statuses = [bench.status(case, result) for result in results]
        grouped.setdefault(case["group"], []).append((case["id"], statuses))
    group_effects = []
    complete_cases = 0
    print("素材组\t四方可比/检查点\t节点效应A\t节点效应B\t交互差（百分点）")
    for group, rows in grouped.items():
        valid = [s for _, s in rows if all(v in bench.DECIDED for v in s)]
        complete_cases += len(valid)
        coverage = bench.fraction(len(valid), len(rows))
        if len(valid) != len(rows):
            missing = [f"{case_id}/{cell}={v}" for case_id, statuses in rows
                       for cell, v in zip(CELLS, statuses) if v not in bench.DECIDED]
            print(group, coverage, "未纳入", "、".join(missing), sep="\t")
            continue
        a0, a1, b0, b1 = [100 * sum(v == "pass" for v in col) / len(valid)
                          for col in zip(*valid)]
        effects = (a1 - a0, b1 - b0, (b1 - b0) - (a1 - a0))
        group_effects.append(effects)
        print(group, coverage, *(f"{x:+.2f}" for x in effects), sep="\t")
    print(f"split={args.split} 四方可比检查点={complete_cases}/{len(ids)} "
          f"完整独立组={len(group_effects)}/{len(grouped)}")
    if group_effects:
        means = [sum(col) / len(col) for col in zip(*group_effects)]
        print("完整组等权均值（百分点）", *(f"{x:+.2f}" for x in means), sep="\t")
    else:
        print("没有完整组，无法估计交互差。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    single = commands.add_parser("check", help="检查两组完整计划是否只变更一个字段")
    single.add_argument("left")
    single.add_argument("right")
    four = commands.add_parser("interaction", help="描述 2×2 交互差")
    for cell in CELLS:
        four.add_argument(cell, type=Path, help=f"{cell} 对应的评审结果 JSONL")
    four.add_argument("--cases", type=Path, default=bench.DEFAULT_CASES)
    four.add_argument("--split", choices=bench.SPLITS, required=True)
    for sub in (single, four):
        sub.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    args = parser.parse_args()
    print("计划与运行文件按提交者声明对应；本工具未核验真实推理、节点执行或生产表现。")
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8-sig"))
        bench.require(isinstance(plan, dict) and isinstance(plan.get("shared"), dict)
                      and isinstance(plan.get("runs"), dict), "计划需包含 shared 和 runs 对象")
        if args.command == "check":
            print(f"{args.left} 与 {args.right} 仅有一处配置差异。{check(plan, args.left, args.right)}")
        else:
            interaction(args, plan)
        return 0
    except (OSError, ValueError) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
