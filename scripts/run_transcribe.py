# -*- coding: utf-8 -*-
"""
批量并行转写：调 skill 的 get_content.py（字幕→缓存→最低码率→Whisper）
支持断点续传（已存在非空输出即跳过）、并发、失败重试、进度日志。

用法:
  python run_transcribe.py --workers 6 --model tiny [--limit 20] [--blogger bloggerA] [--order short|long|none]
"""
import argparse, concurrent.futures as cf, json, os, subprocess, sys, threading, time

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
META = os.path.join(BASE, "data", "meta")
SKILL = r"C:/Users/Leo/.workbuddy/skills/抖音视频分析/scripts"
FETCH = os.path.join(BASE, "scripts", "fetch_content.py")
# ⚠️ 必须用装有 av / faster-whisper 的解释器（managed venv），不能用 sys.executable：
# 若外层用 3.13 启动，子进程继承后 import av 失败 → has_audio() 恒 False → 全部转写被跳过。
PY = r"C:/Users/Leo/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
if not os.path.isfile(PY):
    PY = sys.executable
LOCK = threading.Lock()
STAT = {"done": 0, "skip": 0, "fail": 0, "sec": 0.0}
T0 = [0.0]


def ok(path):
    try:
        if os.path.getsize(path) < 20:
            return False
        d = json.load(open(path, encoding="utf-8"))
        return bool((d.get("subtitle_text") or "").strip())
    except Exception:
        return False


def work(job, model):
    if ok(job["out"]):
        with LOCK:
            STAT["skip"] += 1
        return ("skip", job, 0.0)
    t = time.time()
    try:
        r = subprocess.run(
            [PY, FETCH,
             "--id", job["aweme_id"], "--meta", job["meta"], "--out", job["out"],
             "--model", model],
            capture_output=True, text=True, timeout=5400)
        el = time.time() - t
        if r.returncode == 0 and ok(job["out"]):
            with LOCK:
                STAT["done"] += 1
                STAT["sec"] += job.get("duration", 0) / 1000.0
            return ("done", job, el)
        with LOCK:
            STAT["fail"] += 1
        return ("fail", job, el)
    except Exception:
        with LOCK:
            STAT["fail"] += 1
        return ("fail", job, time.time() - t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--blogger", default="")
    ap.add_argument("--order", default="short", choices=["short", "long", "none"])
    args = ap.parse_args()

    jobs = json.load(open(os.path.join(META, "jobs.json"), encoding="utf-8"))
    if args.blogger:
        jobs = [j for j in jobs if j["blogger"] == args.blogger]
    if args.order == "short":
        jobs.sort(key=lambda x: x.get("duration") or 0)
    elif args.order == "long":
        jobs.sort(key=lambda x: -(x.get("duration") or 0))
    if args.limit:
        jobs = jobs[:args.limit]

    total_audio = sum(j.get("duration", 0) for j in jobs) / 60000.0
    print("任务 %d 条 | 音频合计 %.0f 分钟 | 并发 %d | 模型 %s" % (len(jobs), total_audio, args.workers, args.model), flush=True)
    T0[0] = time.time()
    done_n = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, j, args.model): j for j in jobs}
        for fu in cf.as_completed(futs):
            st, job, el = fu.result()
            done_n += 1
            if done_n % 5 == 0 or st != "done":
                rate = STAT["sec"] / max(time.time() - T0[0], 1)
                print("  [%d/%d] %s %s(%ds) %.0fs | 完成%d 跳过%d 失败%d | %.2fx实时"
                      % (done_n, len(jobs), st, job["blogger"], (job.get("duration") or 0) // 1000,
                         el, STAT["done"], STAT["skip"], STAT["fail"], rate), flush=True)
    el = time.time() - T0[0]
    print("== 结束: 新转写 %d / 跳过 %d / 失败 %d | 耗时 %.1f 分钟" % (STAT["done"], STAT["skip"], STAT["fail"], el / 60), flush=True)


if __name__ == "__main__":
    main()
