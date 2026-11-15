# -*- coding: utf-8 -*-
"""
取口播内容（v3：music 原声优先）
抖音 app/v3 的 play_addr 多为「纯视频流、无音轨」，导致 Whisper 解码失败。
实测 music.play_url（is_original_sound=True）即博主原始录音 MP3，时长与视频一致、体积仅 1/3。
策略：① music 原声 MP3  →  ② video 最低码率档（回退）

用法: python fetch_content.py --id <aweme_id> --meta <detail.json> --out <t.json> [--model base]
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
SKILL = r"C:/Users/Leo/.workbuddy/skills/抖音视频分析/scripts"
CACHE = os.path.join(BASE, "data", "cache")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


def log(m):
    print(m, file=sys.stderr)


def dl(url, dest, timeout=600):
    r = subprocess.run(["curl", "-sL", "--max-time", str(timeout), "-A", UA,
                        "-e", "https://www.douyin.com/", "-o", dest, url],
                       capture_output=True, text=True)
    return os.path.isfile(dest) and os.path.getsize(dest) > 20000


def audio_candidates(d):
    """优先级：原声 MP3 → 视频最低码率档"""
    out = []
    m = d.get("music") or {}
    if m.get("is_original_sound"):
        for u in (m.get("play_url") or {}).get("url_list") or []:
            out.append(("music_original", u))
    elif (m.get("play_url") or {}).get("url_list"):
        for u in (m.get("play_url") or {}).get("url_list") or []:
            out.append(("music_bgm", u))
    v = d.get("video") or {}
    for b in sorted(v.get("bit_rate") or [], key=lambda x: x.get("bit_rate") or 10 ** 12):
        for u in (b.get("play_addr") or {}).get("url_list") or []:
            out.append(("video_low", u))
            break
        break
    for u in (v.get("play_addr") or {}).get("url_list") or []:
        out.append(("video_main", u))
    return out


def has_audio(path):
    try:
        import av
        c = av.open(path)
        return any(s.type == "audio" for s in c.streams)
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="base")
    args = ap.parse_args()

    d = (json.load(open(args.meta, encoding="utf-8")).get("data") or {}).get("aweme_detail") or {}
    os.makedirs(CACHE, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="dy_")
    media, src = None, None
    try:
        for tag, url in audio_candidates(d):
            p = os.path.join(tmpdir, "a_%s" % tag)
            if dl(url, p) and has_audio(p):
                media, src = p, tag
                break
            log("  [skip] %s 无效/无音轨" % tag)
        if not media:
            log("  [ERR] 无可用音频")
            sys.exit(2)

        env = dict(os.environ)
        env["HF_HUB_OFFLINE"] = "1"
        env["OMP_NUM_THREADS"] = "3"
        env["CT2_VERBOSE"] = "0"
        for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            env.pop(k, None)
        r = subprocess.run(
            [sys.executable, os.path.join(SKILL, "transcribe_local.py"), media,
             "--model", args.model, "--language", "zh",
             "--cache-dir", CACHE, "--name", args.id, "--out", args.out],
            capture_output=True, text=True, env=env, timeout=5400)
        if r.returncode != 0 or not os.path.isfile(args.out):
            log("  [ERR] 转写失败: %s" % (r.stderr or "")[-300:])
            sys.exit(3)
        # 补元数据 + 繁转简
        obj = json.load(open(args.out, encoding="utf-8"))
        try:
            import warnings
            warnings.filterwarnings("ignore")
            import zhconv
            obj["subtitle_text"] = zhconv.convert(obj.get("subtitle_text") or "", "zh-cn")
        except Exception as e:
            log("  [warn] 繁简转换失败: %s" % e)
        obj["aweme_id"] = args.id
        obj["audio_source"] = src
        obj["desc"] = d.get("desc", "")
        obj["create_time"] = d.get("create_time")
        obj["video_duration"] = ((d.get("video") or {}).get("duration") or 0) / 1000.0
        json.dump(obj, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        json.dump(obj, open(os.path.join(CACHE, "%s.json" % args.id), "w", encoding="utf-8"), ensure_ascii=False)
        log("  [ok] %s 转写 %d 字" % (src, len(obj.get("subtitle_text") or "")))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
