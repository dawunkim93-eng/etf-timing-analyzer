"""낙폭(52주 고점 대비) 축 백테스트.

기존 매수 신호(저점+10% 이내 AND RSI<=50) 안에서, 52주 고점 대비 낙폭이
얼마나 떨어져 있는지에 따라 63일 후 성과가 어떻게 달라지는지 측정한다.

결과는 data/depth.json 으로 저장한다. 사이트의 "검증" 탭이 이 파일을 읽는다.

중요: 표본이 적은 구간은 **지우지 않는다**. 표본 편향 가능성을 사용자가
직접 판단할 수 있게 하는 것이 이 스크립트의 목적이다.

用法:
    python scripts/backtest.py            # 기존 백테스트 + 낙폭 분석
    python scripts/backtest.py --refresh  # 10년 일봉 다시 받기
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import (  # noqa: E402
    BARS_FOR_52W,
    DEPTH_BUCKETS,
    DEPTH_LOW_SAMPLE,
    DEPTH_SWEET_SPOT,
    MAX_HOLD_DAYS,
    SIGNAL_LOW_FROM_52W,
    SIGNAL_RSI_MAX,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT = DATA_DIR / "depth.json"

# 추가 분석에 쓰는 상한선 필터들 (사용자가 제안한 15/20/25/30 + 주변)
CAP_FILTERS = [-15, -20, -25, -30, -35]
# 구간(밴드) 필터
BAND_FILTERS = [
    ("15~30%", -30, -15),
    ("20~35%", -35, -20),
    ("25~40%", -40, -25),
    ("15~40%", -40, -15),
]
# 순위축 검증용 상위 N
RANK_TOPS = [3, 5, 8]


def _bucket_of(from_high: float) -> str:
    for label, hi, lo in DEPTH_BUCKETS:
        if hi >= from_high > lo:
            return label
    return "15% 미만" if from_high > 0 else "40%+"


def collect_signal_rows(prep: dict[str, dict], bench_close: dict[str, float]) -> list[dict]:
    """기존 매수 신호가 성립한 모든 (종목, 날짜) 행을 모은다.

    여기서는 포트폴리오가 아니라 **신호 단위** 표본이다.
    같은 종목을 여러 날짜에 잡은 것도 모두 넣는다(신호가 실제매매라면
    그때마다 진입했을 테니).
    """
    rows: list[dict] = []
    for t, p in prep.items():
        closes, lows, highs, rsi, dates = p["c"], p["l"], p["h"], p["rsi"], p["dates"]
        n = len(closes)
        for i in range(BARS_FOR_52W, n - MAX_HOLD_DAYS):
            r = rsi[i]
            if r is None or r > SIGNAL_RSI_MAX:
                continue
            low52 = min(lows[i - BARS_FOR_52W + 1: i + 1])
            if closes[i] / low52 - 1 > SIGNAL_LOW_FROM_52W / 100:
                continue
            high52 = max(highs[i - BARS_FOR_52W + 1: i + 1])
            from_high = (closes[i] / high52 - 1) * 100
            fwd = (closes[i + MAX_HOLD_DAYS] / closes[i] - 1) * 100
            b0 = bench_close.get(dates[i])
            b1 = bench_close.get(dates[i + MAX_HOLD_DAYS])
            alpha = fwd - (b1 / b0 - 1) * 100 if (b0 and b1) else None
            rows.append(
                {
                    "ticker": t,
                    "date": dates[i],
                    "year": dates[i][:4],
                    "from_high": from_high,
                    "from_low": (closes[i] / low52 - 1) * 100,
                    "rsi": r,
                    "fwd": fwd,
                    "alpha": alpha,
                }
            )
    return rows


def stats(rows: list[dict]) -> dict:
    if not rows:
        return {}
    fwd = [r["fwd"] for r in rows]
    al = [r["alpha"] for r in rows if r["alpha"] is not None]
    return {
        "n": len(rows),
        "avg_pct": round(statistics.mean(fwd), 2),
        "median_pct": round(statistics.median(fwd), 2),
        "win_pct": round(len([x for x in fwd if x > 0]) / len(fwd) * 100, 1),
        "alpha_pct": round(statistics.mean(al), 2) if al else None,
        "alpha_win_pct": round(len([x for x in al if x > 0]) / len(al) * 100, 1) if al else None,
    }


def yearly_table(rows: list[dict]) -> list[dict]:
    """연도별 알파 — 표본 편향을 그대로 노출하기 위해 전부 남긴다."""
    by_year: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r["alpha"] is not None:
            by_year[r["year"]].append(r["alpha"])
    out = []
    for y in sorted(by_year):
        v = by_year[y]
        out.append({"year": y, "alpha_pct": round(statistics.mean(v), 2), "n": len(v)})
    return out


def concentration(rows: list[dict]) -> dict:
    """종목 집중도 — 상위 5종목이 표본을 얼마나 차지하는가."""
    by_ticker: dict[str, int] = defaultdict(int)
    for r in rows:
        by_ticker[r["ticker"]] += 1
    total = len(rows)
    top = sorted(by_ticker.items(), key=lambda kv: -kv[1])[:5]
    return {
        "unique_tickers": len(by_ticker),
        "top5_share_pct": round(sum(c for _, c in top) / total * 100, 1) if total else 0,
        "top5": [{"ticker": k, "n": c} for k, c in top],
    }


def half_split(rows: list[dict], pivot: str) -> dict:
    """전반/후반 알파 — 과최적화 검사. 방향이 일관되는지 본다.

    분할 기준은 **고정 캘린더 날짜**를 쓴다. 신호가 몰린 해의 중위로
    나누면 표본 밀도에 따라 자르가게 된다. 2022년 bear market 에서
    신호가 821행 중 472행을 차지해서, 신호일 중위로 나누면
    '전반'과 '후반'의 의미가 달라진다. 재현 가능하도록 기준을 고정한다.
    """
    if not rows:
        return {}
    early = [r for r in rows if r["date"] < pivot]
    late = [r for r in rows if r["date"] >= pivot]
    e_al = [r["alpha"] for r in early if r["alpha"] is not None]
    l_al = [r["alpha"] for r in late if r["alpha"] is not None]
    return {
        "pivot": pivot,
        "early_alpha_pct": round(statistics.mean(e_al), 2) if e_al else None,
        "early_n": len(early),
        "late_alpha_pct": round(statistics.mean(l_al), 2) if l_al else None,
        "late_n": len(late),
    }


def build_depth_analysis(prep: dict[str, dict], bench: str) -> dict:
    bench_p = prep.get(bench)
    bench_close = dict(zip(bench_p["dates"], bench_p["c"])) if bench_p else {}
    rows = collect_signal_rows(prep, bench_close)

    # 전반/후반 분할 기준 — 전체 신호 구간의 캘린더 중위 (고정)
    all_dates = sorted({r["date"] for r in rows})
    pivot = all_dates[len(all_dates) // 2] if all_dates else ""

    buckets = []
    for label, hi, lo in DEPTH_BUCKETS:
        sub = [r for r in rows if hi >= r["from_high"] > lo]
        if not sub:
            continue
        st = stats(sub)
        entry = {
            "label": label,
            "lo": lo,
            "hi": hi,
            **st,
            "low_sample": st["n"] < DEPTH_LOW_SAMPLE,
            "sweet_spot": label == DEPTH_SWEET_SPOT,
            "yearly": yearly_table(sub),
            "half": half_split(sub, pivot),
            "concentration": concentration(sub),
        }
        buckets.append(entry)

    # 상한선 필터 — 낙폭이 N% 이내인 신호만
    caps = []
    for cap in CAP_FILTERS:
        sub = [r for r in rows if r["from_high"] <= cap]
        caps.append({"cap": cap, **stats(sub)})

    # 밴드 필터
    bands = []
    for label, hi, lo in BAND_FILTERS:
        sub = [r for r in rows if hi >= r["from_high"] > lo]
        if sub:
            bands.append({"label": label, "lo": lo, "hi": hi, **stats(sub)})

    # 순위축 검증 — 낙폭순 상위 N vs 무작위 N
    by_day: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_day[r["date"]].append(r)
    import random

    rnd = random.Random(42)
    rank_axis = []
    for n in RANK_TOPS:
        picked: list[dict] = []
        for day_rows in by_day.values():
            if len(day_rows) < n:
                continue
            picked.extend(sorted(day_rows, key=lambda r: r["from_high"])[:n])
        ctrl: list[dict] = []
        for day_rows in by_day.values():
            if len(day_rows) < n:
                continue
            ctrl.extend(rnd.sample(day_rows, n))
        rank_axis.append(
            {
                "n_top": n,
                "depth_sorted": stats(picked),
                "random": stats(ctrl),
            }
        )

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "benchmark": bench,
        "universe_size": len(prep),
        "hold_days": MAX_HOLD_DAYS,
        "rules": {
            "low_from_52w": SIGNAL_LOW_FROM_52W,
            "rsi_max": SIGNAL_RSI_MAX,
            "hold_days": MAX_HOLD_DAYS,
        },
        "unfiltered": stats(rows),
        "split_pivot": pivot,
        "buckets": buckets,
        "cap_filters": caps,
        "band_filters": bands,
        "rank_axis": rank_axis,
        "caveats": [
            "표본이 {}행 미만인 구간은 확정된 사실이 아니다. 화면에 저수표로 표시한다.".format(
                DEPTH_LOW_SAMPLE
            ),
            "연도별 알파가 크게 흔들린다. 10년 전체 성적이 좋아도 특정 연도에서는 크게 밀릴 수 있다.",
            "상위 5종목이 표본을 크게 차지한다. 특정 종목 몇 개의 성적이 표 평균을 끌고 간다.",
            "생존 편향 — 지금 살아있는 ETF 만으로 과거를 돌린다. 상장폐지 ETF 의 과거가 없다.",
            "거래비용·세금 미반영.",
            "표본은 신호 단위다. 같은 종목을 여러 날짜에 잡은 것도 모두 들어 있다.",
        ],
    }


def main() -> None:
    import backtest as bt_mod

    refresh = "--refresh" in sys.argv
    print("낙폭 축 백테스트")
    hist = bt_mod.load_history(refresh)
    if not hist:
        raise SystemExit("일봉을 못 받아서 백테스트를 돌릴 수 없습니다.")

    prep = bt_mod.prepare(hist)
    bench = "SPY" if "SPY" in prep else next(iter(prep))

    depth = build_depth_analysis(prep, bench)
    OUT.write_text(json.dumps(depth, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  → {OUT.relative_to(ROOT)}")

    print("\n  버킷별 성과 (기존 신호 안에서)")
    print(f"    {'구간':>10s} {'n':>6s} {'평균':>8s} {'중앙':>8s} {'승률':>7s} {'알파':>8s}")
    for b in depth["buckets"]:
        mark = " ★" if b["sweet_spot"] else (" !" if b["low_sample"] else "")
        print(
            f"    {b['label']:>10s} {b['n']:6d} {b['avg_pct']:+8.2f} {b['median_pct']:+8.2f} "
            f"{b['win_pct']:6.1f}% {(b['alpha_pct'] if b['alpha_pct'] is not None else 0):+8.2f}{mark}"
        )


if __name__ == "__main__":
    main()
