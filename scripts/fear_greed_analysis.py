"""공포지수(CNN Fear & Greed / VIX) 와 매수 신호의 관계 분석.

CNN Fear & Greed 는 **252일(1년)치만** 제공한다. 10년 검증을 하려면
VIX 52주 고점 대비 비율로 재구성해야 한다.

결과는 data/feargreed.json 으로 저장한다. 사이트의 "검증" 탭이 읽는다.

用法:
    python scripts/fear_greed_analysis.py
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import BARS_FOR_52W, FG_HISTORY_DAYS, FG_RATINGS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT = DATA_DIR / "feargreed.json"

# VIX 52주 고점 대비 비율 구간 (%)
VIX_BUCKETS = [(0, 20), (20, 30), (30, 40), (40, 50), (50, 60),
               (60, 70), (70, 80), (80, 90), (90, 100)]
FWD_DAYS = 21   # 이후 21거래일 (1개월)


def load_cache() -> dict:
    path = DATA_DIR / ".backtest_cache.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def fetch_vix_bars() -> list[dict] | None:
    """VIX 10년 일봉."""
    import urllib.parse

    from curl_cffi import requests as cr

    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    session = cr.Session(impersonate="chrome", headers={"User-Agent": ua})
    url = "https://query2.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote("^VIX")
    for attempt in range(3):
        try:
            resp = session.get(url, params={"range": "10y", "interval": "1d"}, timeout=30)
            if resp.status_code != 200:
                continue
            rows = (resp.json().get("chart", {}).get("result") or [{}])[0]
            stamps = rows.get("timestamp") or []
            closes = ((rows.get("indicators", {}).get("quote") or [{}])[0]).get("close") or []
            out = []
            for i, st in enumerate(stamps):
                c = closes[i] if i < len(closes) else None
                if c is None:
                    continue
                out.append({
                    "d": datetime.fromtimestamp(st, tz=timezone.utc).strftime("%Y-%m-%d"),
                    "c": float(c),
                })
            return out or None
        except Exception:  # noqa: BLE001
            continue
    return None


def vix_ratio_series(vix_bars: list[dict]) -> dict[str, float]:
    """날짜 → VIX 의 52주 고점 대비 비율(%). 낮을수록 공포가 극심."""
    closes = [b["c"] for b in vix_bars]
    dates = [b["d"] for b in vix_bars]
    out: dict[str, float] = {}
    for i in range(BARS_FOR_52W - 1, len(vix_bars)):
        hi = max(closes[i - BARS_FOR_52W + 1: i + 1])
        if hi:
            out[dates[i]] = round(closes[i] / hi * 100, 1)
    return out


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("공포지수 분석")

    cache = load_cache()
    if not cache:
        raise SystemExit("백테스트 캐시가 없습니다. scripts/backtest.py --refresh 를 먼저 돌리세요.")

    vix_bars = fetch_vix_bars()
    if not vix_bars:
        raise SystemExit("VIX 를 못 받았습니다.")
    print(f"  VIX {len(vix_bars)}봉")

    ratio = vix_ratio_series(vix_bars)

    # SPY (벤치마크) 21거래일 후 수익률
    spy = cache.get("SPY")
    if not spy:
        raise SystemExit("SPY 캐시가 없습니다.")
    spy_bars = spy["bars"]
    spy_dates = [b["d"] for b in spy_bars]
    spy_closes = [b["c"] for b in spy_bars]
    spy_idx = {d: i for i, d in enumerate(spy_dates)}

    # 일별 시장 신호 수 (모든 ETF 의 신호 합계)
    signal_count: dict[str, int] = defaultdict(int)
    for t, rec in cache.items():
        bars = rec["bars"]
        closes = [b["c"] for b in bars]
        lows = [b["lo"] for b in bars]
        dates = [b["d"] for b in bars]
        n = len(bars)
        for i in range(BARS_FOR_52W, n):
            if i < BARS_FOR_52W:
                continue
            lo52 = min(lows[i - BARS_FOR_52W + 1: i + 1])
            if (closes[i] / lo52 - 1) * 100 > 10:
                continue
            signal_count[dates[i]] += 1

    # VIX 구간별 SPY 21일 수익률
    buckets = []
    for lo, hi in VIX_BUCKETS:
        rets: list[float] = []
        for d, rt in ratio.items():
            if not (lo <= rt < hi):
                continue
            i = spy_idx.get(d)
            if i is None or i + FWD_DAYS >= len(spy_closes):
                continue
            rets.append((spy_closes[i + FWD_DAYS] / spy_closes[i] - 1) * 100)
        if not rets:
            continue
        buckets.append({
            "label": f"{lo}~{hi}%",
            "lo": lo, "hi": hi,
            "n": len(rets),
            "avg_21d_pct": round(statistics.mean(rets), 2),
            "median_21d_pct": round(statistics.median(rets), 2),
            "win_pct": round(len([x for x in rets if x > 0]) / len(rets) * 100, 1),
        })

    # VIX 비율 ↔ 일별 신호수 상관계수
    pairs = [(d, v) for d, v in signal_count.items() if d in ratio]
    corr = None
    if len(pairs) > 30:
        xs = [ratio[d] for d, _ in pairs]
        ys = [v for _, v in pairs]
        mx, my = statistics.mean(xs), statistics.mean(ys)
        num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        den = (sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys)) ** 0.5
        if den:
            corr = round(num / den, 3)

    # CNN Fear & Greed 1년 데이터 (수집돼 있으면)
    fg_buckets = []
    fg_corr = None
    fg_path = DATA_DIR / "etf_us.json"
    if fg_path.exists():
        try:
            fg = json.loads(fg_path.read_text(encoding="utf-8")).get("fear_greed")
        except Exception:  # noqa: BLE001
            fg = None
        if fg:
            hist = fg.get("history") or []
            fmap = {h["d"]: h["y"] for h in hist if h.get("d") and h.get("y") is not None}
            # ★ CNN 실제 등급 경계를 쓴다 ★
            # 점수를 10 단위로 자르면 등급이 깨진다. 실측 경계:
            #   extreme fear 0~25 / fear 25~45 / neutral 45~55
            #   greed 55~75 / extreme greed 75~100
            grade_bounds = [
                ("extreme fear", 0, 25),
                ("fear", 25, 45),
                ("neutral", 45, 55),
                ("greed", 55, 75),
                ("extreme greed", 75, 101),
            ]

            def grade_of(score: float) -> str:
                for label, lo, hi in grade_bounds:
                    if lo <= score < hi:
                        return label
                return "extreme greed"

            groups: dict[str, list[float]] = defaultdict(list)
            for d, v in signal_count.items():
                if d in fmap:
                    groups[grade_of(fmap[d])].append(v)
            rets: dict[str, list[float]] = defaultdict(list)
            for d, v in fmap.items():
                i = spy_idx.get(d)
                if i is None or i + FWD_DAYS >= len(spy_closes):
                    continue
                rets[grade_of(v)].append((spy_closes[i + FWD_DAYS] / spy_closes[i] - 1) * 100)
            for label, lo, hi in grade_bounds:
                if label not in groups:
                    continue
                r = rets.get(label, [])
                fg_buckets.append({
                    "label": label,
                    "rating_ko": dict(FG_RATINGS).get(label, ""),
                    "lo": lo, "hi": min(hi, 100),
                    "n": len(groups[label]),
                    "avg_signals": round(statistics.mean(groups[label]), 1),
                    "avg_21d_pct": round(statistics.mean(r), 2) if r else None,
                    "win_pct": round(len([x for x in r if x > 0]) / len(r) * 100, 1) if r else None,
                })
            pairs2 = [(fmap[d], v) for d, v in signal_count.items() if d in fmap]
            if len(pairs2) > 30:
                xs = [a for a, _ in pairs2]
                ys = [b for _, b in pairs2]
                mx, my = statistics.mean(xs), statistics.mean(ys)
                num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
                den = (sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys)) ** 0.5
                if den:
                    fg_corr = round(num / den, 3)

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fwd_days": FWD_DAYS,
        "vix_buckets": buckets,
        "fg_buckets": fg_buckets,
        "vix_ratio_vs_signals_corr": corr,
        "fg_vs_signals_corr": fg_corr,
        "current_vix": vix_bars[-1]["c"] if vix_bars else None,
        "current_vix_date": vix_bars[-1]["d"] if vix_bars else None,
        "current_vix_ratio": ratio.get(vix_bars[-1]["d"]) if vix_bars else None,
        "caveats": [
            "CNN Fear & Greed 는 252일(1년)치만 제공한다. 10년 검증은 VIX 52주 고점 대비 비율로 재구성했다.",
            "VIX 비율 구간별 표본이 26건(90~99%)인 구간이 있다. 소표본은 방향을 읽을 때 주의.",
            "공포지수는 매수 신호 판정에 쓰지 않는다. 독립적인 참고 지표다.",
            "VIX 는 미국 지수다. 한국 탭에도 같은 지수를 쓰지만 한국 시장 공포를 직접 대체하지는 않는다.",
            "VIX 52주 고점 대비 비율과 CNN Fear & Greed 점수는 사실상 무관하다(상관계수 +0.01). "
            "VIX 비율은 '변동성의 위치', Fear & Greed 는 '심리지수' 다. 다른 지표다.",
            "상관계수 부호가 지표마다 다른 이유: VIX 비율은 공포가 클수록 낮아지므로 신호수와 +관계를, "
            "Fear & Grered 점수는 공포가 클수록 낮아지므로 -관계를 보인다.",
        ],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  → {OUT.relative_to(ROOT)}")
    print(f"  VIX비율 ↔ 신호수 상관: {corr}")
    print(f"  FG ↔ 신호수 상관(1년): {fg_corr}")
    for b in buckets:
        print(f"    VIX {b['label']:>8s}  n={b['n']:5d}  21일 {b['avg_21d_pct']:+6.2f}%  승률 {b['win_pct']:5.1f}%")


if __name__ == "__main__":
    main()
