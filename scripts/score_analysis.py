"""매수 점수 검증 — 확정된 점수(universe.py)가 과거 데이터에서 실제로 순위를 가르는지 확인한다.

CI 에서 backtest.py --refresh 가 연쇄 실행한다 (data/score.json 생성).
점수 기준 자체를 새로 도출하려면 scripts/score_search.py 를 수동 실행한다.

★ 점수는 상대 순위다. 미래 수익 예측이 아니다.
   이 표는 "점수가 높은 그룹이 실제로 더 나았는가"를 숨김 없이 보여준다.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from depth_analysis import collect_signal_rows, stats, yearly_table  # noqa: E402
from universe import (  # noqa: E402
    DEPTH_BUCKETS,
    DEPTH_LOW_SAMPLE,
    MAX_HOLD_DAYS,
    RSI_PERIOD,
    RSI_TIMEFRAME,
    SCORE_DEPTH_POINTS,
    SCORE_MAX,
    SCORE_RSI_POINTS,
    buy_score,
    depth_bucket,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

MIN_GROUP_N = 100   # 이보다 적은 점수 그룹은 "저수표" 로 표시


def rsi_bin_label(rsi: float | None) -> str:
    if rsi is None:
        return "확인 불가"
    for hi, _ in SCORE_RSI_POINTS:
        if rsi < hi:
            return f"<{hi:g}"
    return f"{SCORE_RSI_POINTS[-1][0]:g}+"


def rsi_bin_points(rsi: float | None) -> int:
    if rsi is None:
        return 0
    for hi, pts in SCORE_RSI_POINTS:
        if rsi < hi:
            return pts
    return 0


def build_score_analysis(prep: dict[str, dict], bench: str) -> dict:
    bench_p = prep.get(bench)
    bench_close = dict(zip(bench_p["dates"], bench_p["c"])) if bench_p else {}
    rows = collect_signal_rows(prep, bench_close)

    for r in rows:
        r["score"] = buy_score(depth_bucket(r["from_high"]), r["rsi"])

    # 전반/후반 — 전체 신호 구간의 캘린더 중위 (depth_analysis 와 같은 기준)
    all_dates = sorted({r["date"] for r in rows})
    pivot = all_dates[len(all_dates) // 2] if all_dates else ""
    h1 = [r for r in rows if r["date"] <= pivot]
    h2 = [r for r in rows if r["date"] > pivot]

    # ── 점수 그룹
    groups = []
    for s in range(SCORE_MAX + 1):
        sub = [r for r in rows if r["score"] == s]
        if not sub:
            continue
        st = stats(sub)
        a1 = stats([r for r in sub if r["date"] <= pivot])
        a2 = stats([r for r in sub if r["date"] > pivot])
        groups.append(
            {
                "score": s,
                **st,
                "low_sample": st["n"] < MIN_GROUP_N,
                "alpha_first_half": a1.get("alpha_pct"),
                "alpha_second_half": a2.get("alpha_pct"),
                "n_first_half": a1.get("n", 0),
                "n_second_half": a2.get("n", 0),
                "yearly": yearly_table(sub),
            }
        )
    groups.sort(key=lambda g: g["score"], reverse=True)

    # ── 점수 축 단조성 (표본 100 이상 그룹만)
    solid = [g for g in groups if g["n"] >= MIN_GROUP_N and g["alpha_pct"] is not None]
    inversions = []
    for i in range(len(solid) - 1):
        hi_g, lo_g = solid[i], solid[i + 1]
        if hi_g["alpha_pct"] < lo_g["alpha_pct"]:
            inversions.append(
                {
                    "higher_score": hi_g["score"],
                    "lower_score": lo_g["score"],
                    "higher_alpha": hi_g["alpha_pct"],
                    "lower_alpha": lo_g["alpha_pct"],
                    "n": hi_g["n"] + lo_g["n"],
                }
            )

    # ── 요소별 구간 (점수가 왜 이렇게 생겼는지 화면에서 확인할 수 있게)
    depth_rows = []
    for label, hi, lo in DEPTH_BUCKETS:
        sub = [r for r in rows if hi >= r["from_high"] > lo]
        if not sub:
            continue
        st = stats(sub)
        depth_rows.append(
            {
                "label": label,
                "points": SCORE_DEPTH_POINTS.get(label, 0),
                **st,
                "alpha_first_half": stats([r for r in sub if r["date"] <= pivot]).get("alpha_pct"),
                "alpha_second_half": stats([r for r in sub if r["date"] > pivot]).get("alpha_pct"),
                "low_sample": st["n"] < DEPTH_LOW_SAMPLE,
            }
        )
    rsi_rows = []
    for label in [f"<{hi:g}" for hi, _ in SCORE_RSI_POINTS] + [
        f"{SCORE_RSI_POINTS[-1][0]:g}+"
    ]:
        sub = [r for r in rows if rsi_bin_label(r["rsi"]) == label]
        if not sub:
            continue
        st = stats(sub)
        rsi_rows.append(
            {
                "label": label,
                "points": rsi_bin_points(sub[0]["rsi"]),
                **st,
                "alpha_first_half": stats([r for r in sub if r["date"] <= pivot]).get("alpha_pct"),
                "alpha_second_half": stats([r for r in sub if r["date"] > pivot]).get("alpha_pct"),
            }
        )

    # 연도별: 상위 점수 vs 하위 점수
    top_s = max((g["score"] for g in solid), default=0)
    lo_s = min((g["score"] for g in solid), default=0)
    by_year: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if r["alpha"] is not None:
            by_year[r["year"]][r["score"]].append(r["alpha"])
    year_diff = []
    for y in sorted(by_year):
        hi_v = by_year[y].get(top_s) or []
        lo_v = by_year[y].get(lo_s) or []
        if len(hi_v) < 20 or len(lo_v) < 20:
            continue
        year_diff.append(
            {
                "year": y,
                "top_score": top_s,
                "low_score": lo_s,
                "top_alpha": round(sum(hi_v) / len(hi_v), 2),
                "low_alpha": round(sum(lo_v) / len(lo_v), 2),
                "diff": round(sum(hi_v) / len(hi_v) - sum(lo_v) / len(lo_v), 2),
            }
        )
    wins = len([x for x in year_diff if x["diff"] > 0])

    return {
        "generated_at": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "benchmark": bench,
        "hold_days": MAX_HOLD_DAYS,
        "rsi_timeframe": RSI_TIMEFRAME,
        "rsi_period": RSI_PERIOD,
        "universe_size": len(prep) - 1,
        "score_def": {
            "max": SCORE_MAX,
            "depth": [
                {"label": k, "points": v} for k, v in SCORE_DEPTH_POINTS.items()
            ],
            "rsi": [{"below": hi, "points": p} for hi, p in SCORE_RSI_POINTS],
            "note": "점수 = 낙폭 점수 + RSI 점수. 10년 전/후반 분할 검증을 통과한 요소만 쓴다.",
        },
        "overall": stats(rows),
        "groups": groups,
        "monotonic": {
            "score_axis": len(inversions) == 0,
            "inversions": inversions,
            "method": f"표본 {MIN_GROUP_N} 이상 그룹에서 점수가 높을수록 알파가 높은가",
        },
        "factor_buckets": {"depth": depth_rows, "rsi": rsi_rows},
        "by_year": year_diff,
        "year_wins": {"top_better_years": wins, "measured_years": len(year_diff)},
        "split_pivot": pivot,
        "min_group_n": MIN_GROUP_N,
        "caveats": [
            "점수는 매수 신호끼리의 상대 순위다. 미래 수익 예측이 아니다.",
            "63거래일 창이 겹쳐 통계적 유의성은 과장된다.",
            "생존 편향 — 지금 살아있는 ETF 만으로 과거를 돌린다.",
            "상위 몇 종목이 표본을 크게 차지한다. 연도별 알파를 함께 본다.",
            "거래비용·세금 미반영.",
            "점수 기준은 전반에서 도출해 후반에서 검증했다 (scripts/score_search.py).",
        ],
    }


def main() -> None:
    from backtest import load_history, prepare

    hist = load_history(refresh=False)
    if not hist:
        raise SystemExit("일봉 캐시가 없습니다. python scripts/backtest.py --refresh 먼저 실행하세요.")
    prep = prepare(hist)
    bench = "SPY" if "SPY" in prep else next(iter(prep))
    out = build_score_analysis(prep, bench)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "score.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  → {path.relative_to(ROOT)}")
    print(f"    점수 축 단조: {'✓' if out['monotonic']['score_axis'] else '✗'} "
          f"(역전 {len(out['monotonic']['inversions'])}건)")
    for g in out["groups"]:
        print(f"    {g['score']}점 n={g['n']:6d} 알파 {g['alpha_pct']:+6.2f}% 승률 {g['win_pct']:5.1f}%"
              + (" (저수표)" if g["low_sample"] else ""))
    print(f"    연도별 상위>하위: {out['year_wins']['top_better_years']}/{out['year_wins']['measured_years']}")


if __name__ == "__main__":
    main()
