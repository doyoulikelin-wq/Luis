#!/usr/bin/env python3
"""Prepare blinded reviews offline, or submit them to a configured vision/chat endpoint."""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib import error, parse, request
from bench import load_cases

ROOT = Path(__file__).resolve().parent
IMAGE_KEYS = {"annotated_source_portrait", "app_neutral_pose_frame", "source_portrait",
              "annotated_driver_keyframes", "foreground_occlusion_mask"}
VIDEO_KEYS = {"creator_screen_recording", "timestamped_idle_video", "timestamped_gesture_video",
              "timestamped_still_pose_video", "timestamped_app_video", "timestamped_composite_video",
              "timestamped_driver_video", "timestamped_crossed_arms_video", "timestamped_thinking_video"}
AV_KEY = "timestamped_app_audio_video"


def digest(obj):
    data = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def read_records(path):
    records = {}
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        key = row.get("id") if isinstance(row, dict) else None
        if not isinstance(key, str) or not key or key in records:
            raise ValueError(f"{path}:{line_no}: id 缺失或重复")
        records[key] = row
    return records


def system_prompt():
    text = (ROOT / "judge.md").read_text(encoding="utf-8")
    start, end = "<!-- SYSTEM_START -->", "<!-- SYSTEM_END -->"
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError("judge.md 需要唯一的 SYSTEM_START 和 SYSTEM_END 标记")
    return text.split(start, 1)[1].split(end, 1)[0].strip()


def expected_type(key, case):
    overrides = case.get("evidence_types", {})
    if key in overrides:
        return overrides[key]
    if key == AV_KEY:
        return "audiovideo"
    if key in VIDEO_KEYS:
        return "video"
    return "image" if key in IMAGE_KEYS else "text"


def video_streams(path):
    try:
        cmd = ["ffprobe","-v","error","-show_entries","stream=codec_type",
               "-of","json",str(path)]
        data = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)
        return {s.get("codec_type") for s in json.loads(data.stdout)["streams"]}
    except (FileNotFoundError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        raise ValueError("视频证据需可读的 MP4 和本地 ffprobe 来核验音视频流") from exc


def packet(case, record, folder, media):
    folder = folder.resolve()
    required = case["evidence_required"]
    presented = {k: [] for k in required}
    seen = set()
    brief = {k:v for k,v in case.items() if k not in {"group","split","hard"}}
    content = [{"type": "text", "text": json.dumps(brief, ensure_ascii=False)}]
    gaps = []
    items = record.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{case['id']}: items 需要是列表")
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("证据条目需要是对象")
        key, ref = item.get("key"), item.get("ref")
        if key not in presented or not isinstance(ref, str) or not ref.strip() or ref in seen:
            raise ValueError(f"{case['id']}: 未知证据键或 ref 为空、重复")
        seen.add(ref)
        kinds = [k for k in ("text","image","video") if k in item]
        if len(kinds) != 1:
            raise ValueError(f"{ref}: 需要 text、image、video 其中一个")
        supplied = kinds[0]
        needed = expected_type(key,case)
        content.append({"type": "text", "text": json.dumps({"key":key,"ref":ref}, ensure_ascii=False)})
        if supplied != ("video" if needed == "audiovideo" else needed):
            raise ValueError(f"{ref}: {key} 需要 {needed}，收到 {supplied}")
        if supplied == "text":
            if not isinstance(item["text"], str) or not item["text"].strip():
                raise ValueError(f"{ref}: 证据文本为空")
            content.append({"type": "text", "text": item["text"]})
        else:
            if not isinstance(item[supplied], str):
                raise ValueError(f"{ref}: 媒体路径无效")
            path = (folder / item[supplied]).resolve()
            if folder not in path.parents:
                raise ValueError(f"{ref}: 媒体须放在证据目录内")
            data = path.read_bytes()
            if supplied == "video":
                if data[4:8] != b"ftyp":
                    raise ValueError(f"{ref}: 需要 MP4 容器")
                streams = video_streams(path)
                if "video" not in streams or (needed == "audiovideo" and "audio" not in streams):
                    gaps.append(f"{ref} 缺少所需音视频流")
                if media == "images" or (needed == "audiovideo" and media != "audiovideo"):
                    gaps.append(f"{ref} 超出审核端点的已声明媒体能力")
                mime = "video/mp4"
            elif data.startswith(b"\x89PNG\r\n\x1a\n"):
                mime = "image/png"
            elif data.startswith(b"\xff\xd8\xff"):
                mime = "image/jpeg"
            else:
                raise ValueError(f"{ref}: 仅支持 PNG / JPEG 图片")
            url = "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")
            kind = supplied + "_url"
            content.append({"type":kind,kind:{"url":url}})
        presented[key].append(ref)
    return content, presented, gaps


def validate_decision(case, result, presented):
    if not isinstance(result, dict) or result.get("id") != case["id"]:
        raise ValueError("审核结果 ID 不匹配")
    verdict = result.get("verdict")
    evidence = result.get("evidence")
    if verdict not in ("pass","fail","abstain") or not isinstance(evidence, dict):
        raise ValueError("审核结果 verdict 或 evidence 无效")
    if not isinstance(result.get("note"), str) or not result["note"].strip():
        raise ValueError("审核结果缺少 note")
    if verdict != "abstain" and set(evidence) != set(presented):
        raise ValueError("确定判定须引用每个必需证据键")
    for key, locator in evidence.items():
        if key not in presented or not isinstance(locator, str) or not any(
            locator == r or locator.startswith((r + "｜", r + " | ", r + " ")) for r in presented[key]
        ):
            raise ValueError(f"证据定位没有引用输入中的 ref: {key}")
    return {k: result[k] for k in ("id","verdict","evidence","note")}


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def checked_endpoint(endpoint):
    parsed = parse.urlsplit(endpoint)
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError("请提供不含凭据、查询参数和片段的完整审核端点 URL")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("远程审核端点须使用 HTTPS")
    return endpoint


def ask(endpoint, payload):
    headers = {"Content-Type":"application/json"}
    token = os.environ.get("BENCH_JUDGE_KEY")
    if token:
        headers["Authorization"] = "Bearer " + token
    req = request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers)
    try:
        with request.build_opener(NoRedirect()).open(req, timeout=120) as reply:
            response = json.load(reply)
    except error.HTTPError as exc:
        raise ValueError(f"审核端点 HTTP {exc.code}，请检查 URL、凭据、模型名和图片支持") from exc
    try:
        return json.loads(response["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("端点未返回 Chat Completions 格式的纯 JSON 判定") from exc


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode",choices=("prepare","run"))
    p.add_argument("evidence",type=Path, help="一行一个 case 的证据包")
    p.add_argument("--cases",type=Path,default=ROOT/"cases.jsonl")
    p.add_argument("--model",required=True)
    p.add_argument("--run-id",required=True,help="同一次生成运行的匿名编号，只写入审计记录")
    p.add_argument("--media",choices=("images","video","audiovideo"),default="images",
                   help="已确认的端点能力；后两者需兼容 video_url 输入")
    p.add_argument("--endpoint", help="run 时必需，应显式传完整 /v1/chat/completions 地址")
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--resume",action="store_true",help="复用同证据、同审核配置下已保存的 run 判定")
    args = p.parse_args()
    if args.resume and args.mode != "run":
        p.error("--resume 仅用于 run")
    endpoint = checked_endpoint(args.endpoint) if args.endpoint else None
    if args.mode=="run" and not endpoint:
        p.error("run 需 --endpoint")
    if not args.run_id.strip():
        p.error("--run-id 不能为空")
    cases = load_cases(args.cases)
    rows = read_records(args.evidence)
    if not rows or set(rows) - set(cases):
        raise ValueError("证据包为空或存在未登记的 case ID")
    prompt = system_prompt()
    config = {"model":args.model,"endpoint":endpoint,"protocol":"chat-completions-v1","temperature":0,
              "media":args.media,"system_prompt":digest(prompt),
              "runner":hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    config_hash = digest(config)
    if args.out.resolve() in {args.evidence.resolve(), args.cases.resolve()}:
        raise ValueError("结果路径不能覆盖源数据")
    previous = read_records(args.out) if args.resume and args.out.exists() else {}
    if set(previous) - set(rows):
        raise ValueError("已有输出含此次证据包之外的用例")
    jobs = []
    for cid, record in rows.items():
        case = cases[cid]
        content, refs, gaps = packet(case, record, args.evidence.resolve().parent,args.media)
        meta = {"run_id":args.run_id,"reviewer_config_hash":config_hash,"case_sha256":digest(case),"evidence_sha256":digest(content)}
        if cid in previous:
            if any(previous[cid].get(k) != v for k,v in meta.items()):
                raise ValueError(f"{cid}: 已有结果的用例、证据或审核配置已变更，请指定新输出")
            validate_decision(case,previous[cid],refs)
            continue
        jobs.append((case,content,refs,gaps,meta))
    mode = "a" if args.resume else "x"
    with args.out.open(mode,encoding="utf-8") as out:
        for case, content, refs, gaps, meta in jobs:
            cid = case["id"]
            missing = [k for k,values in refs.items() if not values] + gaps
            body = {"model":args.model,"temperature":0,"messages":[{"role":"system","content":prompt},
                                                                    {"role":"user","content":content}]}
            if args.mode == "prepare":
                row = {"id":cid,"missing":missing,"request":None if missing else body,**meta}
            elif missing:
                row = {"id":cid,"verdict":"abstain","evidence":{},"note":"证据缺项: "+", ".join(missing),**meta}
            else:
                try:
                    row = {**validate_decision(case,ask(endpoint,body),refs),**meta}
                except (ValueError, OSError) as exc:
                    raise ValueError(f"{cid}: {exc}；修复后可用 --resume 继续") from exc
            out.write(json.dumps(row,ensure_ascii=False)+"\n")
            out.flush()
    print(f"{args.mode}: 新增 {len(jobs)} 项，复用 {len(previous)} 项，输出 {args.out}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        sys.exit(str(exc))
