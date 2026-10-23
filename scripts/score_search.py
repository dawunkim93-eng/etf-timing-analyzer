"""매수 점수 기준 탐색 — 과거 데이터에서 "어떤 요소가 실제로 순위를 가르는가"를 찾는다.

수동 실행 전용 (CI 미포함):
    python scripts/score_search.py

설계 (과최적화 방지)
  1) 신호 날짜의 캘린더 중위로 전반/후반을 나눈다 (depth_analysis 와 같은 split_pivot).
  2) 구간 경계·점수 가중치는 **전반에서만** 도출한다.
  3) 후반에 그대로 적용해 순서가 유지되는지 확인한다.
  4) 유지되지 않는 요소는 버린다. 단순한 후보를 우선한다.

신호 조건·청산 규칙은 depth_analysis.collect_signal_rows 와 동일하다
(52주 저점 +10% 이내, 주봉 RSI 50 이하, 63거래일 보유).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backtest import BARS_FOR_52W, MAX_HOLD_DAYS, load_history, prepare  # noqa: E402
from depth_analysis import collect_signal_rows, stats  # noqa: E402
from universe import DEPTH_BUCKETS  # noqa: E402

MAX_POINTS = 4   # 요소 하나가 받을 수 있는 최대 점수
MIN_BIN_N = 200  # 점수 도출에 쓰려면 구간 표본이 이만큼은 있어야 한다
                 # (전반만 쓰므로 전체의 절반. 500으로 두면 30~35% 곡점이 빠진다)
MIN_STABILITY = 0.6  # 전반/후반 구간 알파 순위상관이 이보다 낮으면 요소를 버린다


# ------------------------------------------------------------------ 유틸
def enrich(rows: list[dict], prep: dict[str, dict]) -> list[dict]:
    """collect_signal_rows 결과에 200일선·수익률·이력 필드를 붙인다.

    모두 신호일까지의 데이터만 쓴다 (미래정보 없음).
    """
    idx = {t: {d: i for i, d in enumerate(p["dates"])} for t, p in prep.items()}
    out = []
    for r in rows:
        t, d = r["ticker"], r["date"]
        p = prep.get(t)
        i = idx.get(t, {}).get(d)
        if p is None or i is None:
            continue
        c, closes = p["c"][i], p["c"]
        ma200 = sum(closes[max(0, i - 199): i + 1]) / min(200, i + 1)
        r["ma200_dist"] = (c / ma200 - 1) * 100
        r["ret_3m"] = (c / closes[i - 63] - 1) * 100 if i >= 63 else None
        r["ret_12m"] = (c / closes[i - BARS_FOR_52W] - 1) * 100 if i >= BARS_FOR_52W else None
        r["weeks"] = i // 5
        out.append(r)
    return out


def quantile_edges(vals: list[float], k: int = 5) -> list[float]:
    """분위 경계 (전반에서만 계산해 후반에 그대로 적용)."""
    v = sorted(vals)
    if not v:
        return []
    return [v[int(len(v) * j / k)] for j in range(1, k)]


def bin_of_num(x: float | None, edges: list[float]) -> int:
    if x is None:
        return 0
    for j, e in enumerate(edges):
        if x < e:
            return j
    return len(edges)


def spearman(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return 0.0

    def ranks(v: list[float]) -> list[float]:
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else 0.0


def tstat(r: float, n: int) -> float:
    if n < 3 or abs(r) >= 1:
        return 0.0
    return r * ((n - 2) / (1 - r * r)) ** 0.5


# ------------------------------------------------------------------ 요소 정의
NUM_FACTORS = {
    "low": ("저점 근접도", "from_low", [2.0, 4.0, 6.0, 8.0]),
    "rsi": ("RSI", "rsi", [35.0, 40.0, 45.0]),
    "ma200": ("200일선 이격", "ma200_dist", None),   # 전반 분위로 경계 도출
    "ret3": ("3개월 수익률", "ret_3m", None),
    "ret12": ("1년 수익률", "ret_12m", None),
    "weeks": ("이력", "weeks", [52, 104, 260]),
}


def depth_bin(r: dict) -> int:
    """낙폭은 기존 버킷 라벨을 그대로 쓴다 (경계를 새로 만들지 않는다)."""
    v = r["from_high"]
    for j, (_, hi, lo) in enumerate(DEPTH_BUCKETS):
        if hi >= v > lo:
            return j
    return len(DEPTH_BUCKETS) - 1


def factor_bins(name: str, rows: list[dict], edges: list[float] | None) -> list[int]:
    if name == "depth":
        return [depth_bin(r) for r in rows]
    field = NUM_FACTORS[name][1]
    return [bin_of_num(r.get(field), edges or []) for r in rows]


def edges_for(name: str, train: list[dict]) -> list[float] | None:
    if name == "depth":
        return None
    fixed = NUM_FACTORS[name][2]
    if fixed is not None:
        return fixed
    field = NUM_FACTORS[name][1]
    vals = [r[field] for r in train if r.get(field) is not None]
    return quantile_edges(vals, 5)


def bin_labels(name: str, edges: list[float] | None, nbins: int) -> list[str]:
    if name == "depth":
        return [b[0] for b in DEPTH_BUCKETS]
    label = NUM_FACTORS[name][0]
    if not edges:
        return [label]
    out = []
    prev = None
    for e in edges:
        out.append(f"<{e:g}" if prev is None else f"{prev:g}~{e:g}")
        prev = e
    out.append(f"{prev:g}+")
    return out


# ------------------------------------------------------------------ 점수 도출
def derive_factor(name: str, train: list[dict], test: list[dict]) -> dict:
    """전반에서 구간별 알파를 재고, 알파 순위를 0~MAX_POINTS 점수로 매핑한다.

    매핑: point = round((alpha - min) / (max - min) * P)
          P = round(이 요소의 알파 폭 / 전체 요소 중 최대 폭 * MAX_POINTS)
    """
    edges = edges_for(name, train)
    nb = len(bin_labels(name, edges, 0)) if name != "depth" else len(DEPTH_BUCKETS)
    if name != "depth":
        nb = len(bin_labels(name, edges, 0))

    def by_bin(rows: list[dict]) -> list[dict]:
        bins = factor_bins(name, rows, edges)
        out = []
        for b in range(nb):
            sub = [r for r, k in zip(rows, bins) if k == b]
            if not sub:
                out.append({"n": 0})
                continue
            st = stats(sub)
            out.append(st)
        return out

    tr, te = by_bin(train), by_bin(test)
    # 표본이 충분한 구간만 점수 도출에 쓴다 (소표본 극단값이 가중치를 왜곡한다)
    usable = [
        i for i, b in enumerate(tr)
        if b.get("n", 0) >= MIN_BIN_N and b.get("alpha_pct") is not None
    ]
    alphas = [tr[i]["alpha_pct"] for i in usable]
    if not alphas:
        return {"name": name, "edges": edges, "points": [], "train": tr, "test": te,
                "spread": 0.0, "usable": [], "stability": 0.0}
    lo, hi = min(alphas), max(alphas)
    # 전/후반 구간 알파 순위상관 = 요소 안정성 (둘 다 표본 충분한 구간만)
    pairs = [
        (tr[i]["alpha_pct"], te[i]["alpha_pct"])
        for i in usable
        if i < len(te) and te[i].get("n", 0) >= MIN_BIN_N and te[i].get("alpha_pct") is not None
    ]
    stab = spearman([a for a, _ in pairs], [b for _, b in pairs]) if len(pairs) >= 3 else 0.0
    return {
        "name": name, "edges": edges, "train": tr, "test": te,
        "spread": hi - lo, "alpha_lo": lo, "alpha_hi": hi,
        "labels": bin_labels(name, edges, nb), "usable": usable, "stability": stab,
    }


def assign_points(f: dict, max_points: int) -> list[int]:
    lo, hi = f.get("alpha_lo"), f.get("alpha_hi")
    if lo is None or hi is None or hi <= lo:
        return [0] * len(f["train"])
    out = []
    for i, b in enumerate(f["train"]):
        if i not in f.get("usable", []):
            out.append(0)
            continue
        out.append(round((b["alpha_pct"] - lo) / (hi - lo) * max_points))
    return out


def score_rows(rows: list[dict], factors: list[dict], names: list[str]) -> list[int]:
    out = []
    for r in rows:
        s = 0
        for f, nm in zip(factors, names):
            b = factor_bins(nm, [r], f["edges"])[0]
            pts = f["points"]
            s += pts[b] if b < len(pts) else 0
        out.append(s)
    return out


def evaluate(rows: list[dict], scores: list[int]) -> dict:
    by = {}
    for r, s in zip(rows, scores):
        by.setdefault(s, []).append(r)
    groups = []
    for s in sorted(by, reverse=True):
        st = stats(by[s])
        groups.append({"score": s, **st})
    alphas = [g["alpha_pct"] for g in groups if g["n"] >= 30 and g["alpha_pct"] is not None]
    monotonic = all(alphas[i] >= alphas[i + 1] for i in range(len(alphas) - 1)) if len(alphas) > 1 else False
    ic = spearman([float(s) for s in scores], [r["alpha"] if r["alpha"] is not None else 0.0 for r in rows])
    return {"groups": groups, "monotonic": monotonic, "ic": ic, "n": len(rows)}


def fmt_alpha(x: float | None) -> str:
    return "   -  " if x is None else f"{x:+6.2f}"


# ------------------------------------------------------------------ main
def main() -> None:
    hist = load_history(refresh=False)
    prep = prepare(hist)
    bench = "SPY" if "SPY" in prep else next(iter(prep))
    bench_close = dict(zip(prep[bench]["dates"], prep[bench]["c"]))
    rows = enrich(collect_signal_rows(prep, bench_close), prep)
    print(f"신호 표본 {len(rows):,}건 · 벤치마크 {bench} · 보유 {MAX_HOLD_DAYS}거래일")

    dates = sorted({r["date"] for r in rows})
    pivot = dates[len(dates) // 2]
    train = [r for r in rows if r["date"] <= pivot]
    test = [r for r in rows if r["date"] > pivot]
    print(f"전반 {len(train):,}건 ({dates[0]} ~ {pivot}) | 후반 {len(test):,}건")

    # ── 1) 요소별 구간 (전반 도출 → 후반 검증)
    print("\n=== 요소별 구간 (전반 → 후반) ===")
    all_names = ["depth", *NUM_FACTORS]
    derived = {}
    for nm in all_names:
        f = derive_factor(nm, train, test)
        derived[nm] = f
        print(f"\n[{f['labels'][0] if nm=='depth' else NUM_FACTORS[nm][0]}]  알파폭 {f['spread']:+.2f}")
        print(f"  {'구간':<12}{'전반n':>7}{'전반알파':>9}{'후반n':>7}{'후반알파':>9}  유지")
        for i, lb in enumerate(f["labels"]):
            tr = f["train"][i] if i < len(f["train"]) else {}
            te = f["test"][i] if i < len(f["test"]) else {}
            a1, a2 = tr.get("alpha_pct"), te.get("alpha_pct")
            keep = "" if a1 is None or a2 is None else ("✓" if (a1 > 0) == (a2 > 0) else "✗")
            print(f"  {lb:<12}{tr.get('n',0):>7}{fmt_alpha(a1):>9}{te.get('n',0):>7}{fmt_alpha(a2):>9}  {keep}")

    # ── 2) 가중치 배분 — 안정성 통과 요소에만, 알파폭 비례 (최대 4점)
    print("\n=== 요소 안정성 (전/후반 구간 알파 순위상관) ===")
    stable = []
    for nm, f in derived.items():
        lbl = "낙폭" if nm == "depth" else NUM_FACTORS[nm][0]
        keep = f["stability"] >= MIN_STABILITY
        if keep:
            stable.append(nm)
        print(f"  {lbl:<14} 안정성 {f['stability']:+.2f}  알파폭 {f['spread']:+.2f}  {'유지' if keep else '탈락'}")
    max_spread = max((derived[n]["spread"] for n in stable), default=0.0)
    for nm, f in derived.items():
        if nm not in stable or max_spread <= 0:
            f["max_points"], f["points"] = 0, [0] * len(f["train"])
            continue
        p = round(f["spread"] / max_spread * MAX_POINTS)
        f["max_points"] = max(0, min(MAX_POINTS, p))
        f["points"] = assign_points(f, f["max_points"])

    print("\n=== 요소별 점수 (안정성 통과 + 알파폭 비례) ===")
    for nm, f in derived.items():
        lbl = "낙폭" if nm == "depth" else NUM_FACTORS[nm][0]
        print(f"  {lbl:<14} 최대 {f['max_points']}점 | " +
              " ".join(f"{lb}={p}" for lb, p in zip(f["labels"], f["points"])))

    # ── 3) 후보 점수 비교
    candidates = {
        "S1 낙폭만": ["depth"],
        "S2 낙폭+저점": ["depth", "low"],
        "S3 낙폭+저점+RSI": ["depth", "low", "rsi"],
        "S4 낙폭+RSI": ["depth", "rsi"],
        "S5 낙폭+200일선": ["depth", "ma200"],
        "S6 낙폭+3개월": ["depth", "ret3"],
        "S7 낙폭+1년": ["depth", "ret12"],
        "S8 낙폭+저점+RSI+200일선": ["depth", "low", "rsi", "ma200"],
    }
    print("\n=== 후보 점수 비교 (점수는 전반에서 도출, 후반은 검증) ===")
    print(f"  {'후보':<26}{'전반IC':>8}{'후반IC':>8}{'후반단조':>9}{'후반최상위알파':>13}  판정")
    results = {}
    for label, names in candidates.items():
        fs = [derived[n] for n in names]
        s_tr = score_rows(train, fs, names)
        s_te = score_rows(test, fs, names)
        e_tr = evaluate(train, s_tr)
        e_te = evaluate(test, s_te)
        top = max((g["alpha_pct"] for g in e_te["groups"] if g["n"] >= 30 and g["alpha_pct"] is not None), default=None)
        ok = e_te["monotonic"] and (e_te["ic"] or 0) > 0
        results[label] = {"train_ic": e_tr["ic"], "test_ic": e_te["ic"],
                          "test_monotonic": e_te["monotonic"], "top_alpha": top, "groups": e_te["groups"]}
        print(f"  {label:<26}{e_tr['ic']:>8.3f}{e_te['ic']:>8.3f}"
              f"{'✓' if e_te['monotonic'] else '✗':>9}{fmt_alpha(top):>13}  {'채택후보' if ok else ''}")

    # ── 4) 주요 후보의 그룹 상세 (전반 도출 → 후반 검증)
    for label in ("S1 낙폭만", "S4 낙폭+RSI", "S5 낙폭+200일선"):
        names = candidates[label]
        fs = [derived[n] for n in names]
        e_tr = evaluate(train, score_rows(train, fs, names))
        e_te = evaluate(test, score_rows(test, fs, names))
        print(f"\n--- {label} 그룹별 (점수: 전반n/전반알파 → 후반n/후반알파/후반승률) ---")
        gtr = {g["score"]: g for g in e_tr["groups"]}
        for g in e_te["groups"]:
            t = gtr.get(g["score"], {})
            print(f"  {g['score']:>2}점  {t.get('n',0):>6}{fmt_alpha(t.get('alpha_pct'))}"
                  f"  → {g['n']:>6}{fmt_alpha(g['alpha_pct'])}  {g['win_pct']:>5.1f}%")

    # ── 5) 연도별 안정성 (상위 그룹 vs 하위 그룹)
    for label in ("S1 낙폭만", "S4 낙폭+RSI"):
        names = candidates[label]
        fs = [derived[n] for n in names]
        sc = score_rows(rows, fs, names)
        by_year: dict[str, dict[int, list]] = {}
        for r, scv in zip(rows, sc):
            by_year.setdefault(r["year"], {}).setdefault(scv, []).append(r)
        years = sorted(by_year)
        top_s = max(sc)
        print(f"\n--- {label} 연도별: {top_s}점 그룹 알파 | 0점 그룹 알파 | 차이 ---")
        wins = 0
        for y in years:
            hi = by_year[y].get(top_s, [])
            lo = by_year[y].get(0, [])
            if len(hi) < 20 or len(lo) < 20:
                continue
            a_hi = stats(hi)["alpha_pct"]
            a_lo = stats(lo)["alpha_pct"]
            diff = a_hi - a_lo
            wins += 1 if diff > 0 else 0
            print(f"  {y}  {a_hi:+6.2f}  | {a_lo:+6.2f}  | {diff:+6.2f}")
        print(f"  → 상위가 하위보다 나은 해: {wins}년")

    print("\n※ IC = 점수와 63일 알파의 순위상관. 63일 창이 겹쳐 t값은 과장된다.")
    print("※ 후반 단조 = 후반 표본에서 점수가 높을수록 알파가 높은가 (n>=30 구간만).")


if __name__ == "__main__":
    main()
