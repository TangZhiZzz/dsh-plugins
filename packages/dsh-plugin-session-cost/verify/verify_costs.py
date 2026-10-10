#!/usr/bin/env python3
"""独立交叉验证：直接解压 ~/.dsh/sessions 下的原始 .jsonl.zstd 会话日志，
自己算每个会话的 token 与金额，再和插件 HTTP 端点返回的 JSON 逐项比对。

它刻意不复用插件的任何代码：解码、事件解析、价目表、峰谷判定全部重写一遍。
两者一致才算“金额不是实现自说自话”。

用法（在 dsh-plugin-session-cost 目录内）：
    python verify/verify_costs.py                 # 先自己抓一次端点，再比对
    python verify/verify_costs.py summary.json    # 和已保存的端点响应比对

依赖：zstandard（本机已装 0.25.0）。python 侧不需要 requests。
"""

from __future__ import annotations

import collections
import datetime as dt
import glob
import json
import os
import sys
import urllib.request
import zstandard

ENDPOINT = "http://127.0.0.1:19387/dsh-session-cost/summary"
SESSIONS_ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")
TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai，无夏令时

# 与插件默认价目表相同来源：DeepSeek 官方《模型 & 价格》，人民币 / 百万 tokens，高峰时段价。
RATES = {
    "deepseek-flash": (0.04, 2.0, 8.0),
    "deepseek-v4-flash": (0.04, 2.0, 8.0),
    "deepseek-v4-flash-vision-exp": (0.04, 2.0, 8.0),
    "deepseek-v4-pro": (0.30, 9.0, 27.0),
    "deepseek-chat": (0.5, 2.0, 8.0),
    "deepseek-reasoner": (1.0, 4.0, 16.0),
}
PREFIX_RATES = {"deepseek-v4.1-flash": (0.04, 2.0, 8.0)}
OFF_PEAK_FACTOR = 0.5
PEAK_WINDOWS = ((9 * 60, 12 * 60), (14 * 60, 18 * 60))


def rate_for(model: str):
    if model in RATES:
        return RATES[model]
    best = None
    for prefix, rate in PREFIX_RATES.items():
        if model.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), rate)
    return None if best is None else best[1]


def tier_of(epoch_ms: int) -> str:
    local = dt.datetime.fromtimestamp(epoch_ms / 1000, TZ)
    if local.weekday() >= 5:  # 5=周六 6=周日
        return "offPeak"
    minutes = local.hour * 60 + local.minute
    for start, end in PEAK_WINDOWS:
        if start <= minutes < end:
            return "peak"
    return "offPeak"


def pick_log(session_dir: str) -> str | None:
    """同一会话可能有多个格式代（session.jsonl.zstd / session.v4.jsonl.zstd），取版本最高的。"""
    best = None
    for path in glob.glob(os.path.join(session_dir, "session*.jsonl.zstd")):
        name = os.path.basename(path)
        version = 0
        if name.startswith("session.v") and name.endswith(".jsonl.zstd"):
            try:
                version = int(name[len("session.v"):-len(".jsonl.zstd")])
            except ValueError:
                version = 0
        if best is None or version > best[0]:
            best = (version, path)
    return None if best is None else best[1]


def read_events(path: str):
    with open(path, "rb") as handle:
        raw = zstandard.ZstdDecompressor().stream_reader(handle).read().decode("utf-8")
    for line in raw.splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def usage_of(data: dict):
    direct = data.get("usage")
    if isinstance(direct, dict) and isinstance(direct.get("inputTokens"), (int, float)):
        return direct
    last = None
    for record in data.get("stream") or []:
        chunk = record.get("chunk") if isinstance(record, dict) else None
        if isinstance(chunk, dict) and chunk.get("type") == "usage" and isinstance(chunk.get("usage"), dict):
            last = chunk["usage"]
    return last


def fold(path: str):
    acc = {
        "calls": 0,
        "usageMissingCalls": 0,
        "unpricedCalls": 0,
        "cost": 0.0,
        "cacheHit": 0,
        "cacheMiss": 0,
        "output": 0,
        "seedMarkers": 0,
    }
    events = list(read_events(path))
    # 说明：本机实测 session/end-seed 只是日志里的“种子区块结束”标记，这些会话的
    # inheritedEventCount 都是 0（插件结果 = 全文件求和）。真正会承接父会话前缀的
    # （fork / subagent）会话由插件按 inheritedEventCount 排除，脚本会对这类会话单独提示。
    acc["seedMarkers"] = sum(1 for event in events if event.get("type") == "session/end-seed")
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data") or {}
        acc["calls"] += 1
        usage = usage_of(data)
        if usage is None:
            acc["usageMissingCalls"] += 1
            continue
        hit = usage.get("cacheReadTokens") or 0
        miss = usage.get("inputTokens") or 0
        out = usage.get("outputTokens") or 0
        acc["cacheHit"] += hit
        acc["cacheMiss"] += miss
        acc["output"] += out
        model = ((data.get("message") or {}).get("source") or {}).get("model") or "unknown"
        rate = rate_for(model)
        if rate is None:
            acc["unpricedCalls"] += 1
            continue
        factor = OFF_PEAK_FACTOR if tier_of(event.get("time") or 0) == "offPeak" else 1.0
        acc["cost"] += (hit * rate[0] + miss * rate[1] + out * rate[2]) / 1e6 * factor
    return acc


def fetch_endpoint() -> dict:
    with urllib.request.urlopen(ENDPOINT, timeout=120) as response:
        return json.load(response)


def main() -> int:
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        source = sys.argv[1]
    else:
        payload = fetch_endpoint()
        source = ENDPOINT

    plugin = {row["id"]: row for row in payload["sessions"]}
    print(f"插件端点：{source}  sessions={len(plugin)}  totals.cost={payload['totals']['cost']}")

    raw = {}
    for session_dir in sorted(glob.glob(os.path.join(SESSIONS_ROOT, "*", "session-*"))):
        path = pick_log(session_dir)
        if path is None:
            continue
        session_id = os.path.basename(session_dir)
        raw[session_id] = fold(path)

    print(f"原始日志：{len(raw)} 个会话  合计金额={sum(v['cost'] for v in raw.values()):.6f}")

    failures = 0
    print("\n{:<42} {:>5} {:>10} {:>10} {:>10} {:>11} {:>11}  {}".format(
        "session", "calls", "cacheHit", "cacheMiss", "output", "cost(raw)", "cost(plugin)", "verdict"))
    inherited = 0
    for session_id in sorted(set(raw) | set(plugin)):
        mine = raw.get(session_id)
        theirs = plugin.get(session_id)
        if mine is None or theirs is None:
            print(f"!! {session_id} 只在{'日志' if mine else '端点'}里存在")
            failures += 1
            continue
        theirs_tokens = theirs["tokens"]
        checks = [
            ("calls", mine["calls"], theirs["calls"]),
            ("cacheHit", mine["cacheHit"], theirs_tokens["cacheHit"]),
            ("cacheMiss", mine["cacheMiss"], theirs_tokens["cacheMiss"]),
            ("output", mine["output"], theirs_tokens["output"]),
        ]
        row_failures = [name for name, a, b in checks if a != b]
        if abs(mine["cost"] - theirs["cost"]) > 1e-6:
            row_failures.append("cost")
        verdict = "MISMATCH:" + ",".join(row_failures) if row_failures else "ok"
        if theirs.get("parentSession") or theirs.get("origin") == "subagent":
            inherited += 1
            verdict += " (fork/subagent：插件按 inheritedEventCount 排除承接前缀)"
        if row_failures:
            failures += 1
        print("{:<42} {:>5} {:>10} {:>10} {:>10} {:>11.6f} {:>11.6f}  {}".format(
            session_id, mine["calls"], mine["cacheHit"], mine["cacheMiss"],
            mine["output"], mine["cost"], theirs["cost"], verdict))

    raw_total = sum(v["cost"] for v in raw.values())
    raw_calls = sum(v["calls"] for v in raw.values())
    raw_hit = sum(v["cacheHit"] for v in raw.values())
    raw_miss = sum(v["cacheMiss"] for v in raw.values())
    raw_out = sum(v["output"] for v in raw.values())
    totals = payload["totals"]
    print("\n--- 全局合计 ---")
    print(f"calls      raw={raw_calls:<10} plugin={totals['calls']}")
    print(f"cacheHit   raw={raw_hit:<10} plugin={totals['tokens']['cacheHit']}")
    print(f"cacheMiss  raw={raw_miss:<10} plugin={totals['tokens']['cacheMiss']}")
    print(f"output     raw={raw_out:<10} plugin={totals['tokens']['output']}")
    print(f"cost       raw={raw_total:.6f}  plugin={totals['cost']:.6f}")
    for name, a, b in (("calls", raw_calls, totals["calls"]), ("cacheHit", raw_hit, totals["tokens"]["cacheHit"]),
                       ("cacheMiss", raw_miss, totals["tokens"]["cacheMiss"]), ("output", raw_out, totals["tokens"]["output"])):
        if a != b:
            failures += 1
            print(f"!! 合计 {name} 不一致")
    if abs(raw_total - totals["cost"]) > 1e-4:
        # 插件先把每个会话的金额四舍五入到 6 位再求和，脚本不round；28 个会话累计差异应远小于 1e-4
        failures += 1
        print("!! 合计 cost 不一致")
    else:
        print(f"cost 差值={abs(raw_total - totals['cost']):.2e}（会话级四舍五入累计，容差 1e-4）")

    print("\n" + ("PASS：独立实现与插件逐会话一致" if failures == 0 else f"FAIL：{failures} 处不一致"))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
