"""한국 공포·탐욕 지수 분석 (장기 통계).

★ 한국에는 "공식" 공포·탐욕 지수가 없다 ★
KRX 는 VKOSPI 등 변동성 지수만 공표하고, 공포·탐욕 지수는 전부
민간 서비스가 각각 계산한다. 그래서 소스마다 값이 다르다.

여기서는 2가지를 계산한다:
  1) 한국 공포·탐욕 ↔ 한국 ETF 매수 신호수  (상관계수)
  2) 한국 공포·탐욕 구간별 이후 21거래일 KOSPI 수익률

장기 이력은 GitHub kospi-feargreedindex (1087포인트, 2022-03~2026-08).
★ 이 소스는 **2개월 지연**이 있다. 현재값으로 쓰지 않고 통계 검증에만 쓴다. ★

用法:
    python scripts/fear_greed_analysis.py            # 캐시 사용
    python scripts/fear_greed_analysis.py --refresh  # 한국 ETF 10년 재수집
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import (  # noqa: E402
    BARS_FOR_52W,
    KR_FG_GITHUB_URL,
    KR_FG_RATINGS,
    MAX_HOLD_DAYS,
    RSI_PERIOD,
    SIGNAL_LOW_FROM_52W,
    SIGNAL_RSI_MAX,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT = DATA_DIR / "feargreed.json"
KR_CACHE = DATA_DIR / ".kr_cache.json"

FWD_DAYS = 21          # 이후 21거래일 (1개월)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


# ------------------------------------------------------------------ 유틸
def _session():
    from curl_cffi import requests as cr

    return cr.Session(impersonate="chrome", headers={"User-Agent": UA})


def to_weekly(bars: list[dict]) -> list[dict]:
    """일봉 → 주봉 (ISO 주, 주의 마지막 거래일)."""
    weeks: dict[tuple[int, int], dict] = {}
    for b in bars:
        d = dt.date.fromisoformat(b["d"])
        weeks[d.isocalendar()[:2]] = b
    return [weeks[k] for k in sorted(weeks)]


def rsi_series(closes: list[float], period: int = RSI_PERIOD) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    if len(closes) < period + 1:
        return out
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(x, 0.0) for x in deltas]
    losses = [max(-x, 0.0) for x in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out[i + 1] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


# ---------------------------------------------------------- 데이터 수집
def fetch_kr_fg_history() -> dict[str, float]:
    """GitHub 장기 한국 공포·탐욕 이력. {날짜: 점수}"""
    s = _session()
    try:
        r = s.get(KR_FG_GITHUB_URL, timeout=30)
        if r.status_code != 200:
            print(f"  ! GitHub 한국 지수 HTTP {r.status_code}")
            return {}
        payload = r.json()
    except Exception as exc:  # noqa: BLE001
        print(f"  ! GitHub 한국 지수 실패: {type(exc).__name__}")
        return {}
    out: dict[str, float] = {}
    for row in payload.get("data") or []:
        day = row.get("x")
        val = row.get("z")
        if day and isinstance(val, (int, float)):
            out[day] = float(val)
    print(f"  GitHub 한국 지수 {len(out)}포인트")
    return out


def fetch_kospi() -> list[dict]:
    s = _session()
    try:
        r = s.get("https://query2.finance.yahoo.com/v8/finance/chart/%5EKS11",
                  params={"range": "10y", "interval": "1d"}, timeout=30)
        if r.status_code != 200:
            return []
        res = r.json()["chart"]["result"][0]
        stamps = res.get("timestamp") or []
        closes = (res.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
        out = []
        for i, st in enumerate(stamps):
            c = closes[i] if i < len(closes) else None
            if c is None:
                continue
            out.append({
                "d": dt.datetime.fromtimestamp(st, tz=dt.timezone.utc).strftime("%Y-%m-%d"),
                "c": float(c),
            })
        return out
    except Exception:  # noqa: BLE001
        return []


def load_kr_etf_cache(refresh: bool) -> dict[str, list[dict]]:
    """한국 ETF 10년 일봉 캐시."""
    if not refresh and KR_CACHE.exists():
        try:
            cached = json.loads(KR_CACHE.read_text(encoding="utf-8"))
            if cached:
                print(f"  한국 ETF 캐시 사용: {len(cached)}종목")
                return cached
        except Exception:  # noqa: BLE001
            pass

    # 유니버리의 한국 ETF 코드
    from universe import KR_ETFS

    codes = [c for c, *_ in KR_ETFS]
    s = _session()
    from concurrent.futures import ThreadPoolExecutor

    def one(code: str):
        try:
            r = s.get(f"https://query2.finance.yahoo.com/v8/finance/chart/{code}.KS",
                      params={"range": "10y", "interval": "1d"}, timeout=30)
            if r.status_code != 200:
                return None
            res = r.json()["chart"]["result"][0]
            stamps = res.get("timestamp") or []
            quote = (res.get("indicators", {}).get("quote") or [{}])[0]
            closes = quote.get("close") or []
            lows = quote.get("low") or []
            out = []
            for i, st in enumerate(stamps):
                c = closes[i] if i < len(closes) else None
                lo = lows[i] if i < len(lows) else None
                if c is None or lo is None:
                    continue
                out.append({
                    "d": dt.datetime.fromtimestamp(st, tz=dt.timezone.utc).strftime("%Y-%m-%d"),
                    "c": float(c), "lo": float(lo),
                })
            return (code, out) if len(out) > 300 else None
        except Exception:  # noqa: BLE001
            return None

    print(f"  한국 ETF {len(codes)}종목 10년 수집…")
    out: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for item in ex.map(one, codes):
            if item:
                code, bars = item
                out[code] = bars
    KR_CACHE.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"  한국 ETF {len(out)}/{len(codes)} 수집 (캐시 저장)")
    return out


def kr_signal_counts(kr_hist: dict[str, list[dict]]) -> dict[str, int]:
    """날짜 → 그날 매수 신호가 났던 한국 ETF 개수."""
    counts: dict[str, int] = defaultdict(int)
    for _code, bars in kr_hist.items():
        closes = [b["c"] for b in bars]
        lows = [b["lo"] for b in bars]
        dates = [b["d"] for b in bars]
        n = len(bars)
        # 주봉 RSI (무목적 — 이미 끝난 주만)
        weekly = to_weekly(bars)
        w_dates = [b["d"] for b in weekly]
        w_rsi = rsi_series([b["c"] for b in weekly])
        wmap: dict[str, float | None] = {}
        for b in bars:
            j = bisect.bisect_left(w_dates, b["d"]) - 1
            wmap[b["d"]] = w_rsi[j] if j >= 0 else None
        for i in range(BARS_FOR_52W, n):
            r = wmap[dates[i]]
            if r is None or r > SIGNAL_RSI_MAX:
                continue
            lo52 = min(lows[i - BARS_FOR_52W + 1: i + 1])
            if (closes[i] / lo52 - 1) * 100 > SIGNAL_LOW_FROM_52W:
                continue
            counts[dates[i]] += 1
    return dict(counts)


# ------------------------------------------------------------------ 계산
def kr_analysis(kr_hist: dict[str, list[dict]], fg_hist: dict[str, float],
                kospi: list[dict]) -> dict:
    signal_counts = kr_signal_counts(kr_hist)
    kospi_idx = {b["d"]: i for i, b in enumerate(kospi)}

    # 상관계수
    corr = None
    pairs = [(d, v) for d, v in signal_counts.items() if d in fg_hist]
    if len(pairs) > 30:
        xs = [fg_hist[d] for d, _ in pairs]
        ys = [v for _, v in pairs]
        mx, my = statistics.mean(xs), statistics.mean(ys)
        num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        den = (sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys)) ** 0.5
        if den:
            corr = round(num / den, 3)

    # 구간별
    buckets = []
    for lo, hi, ko, en in KR_FG_RATINGS:
        sig_vals: list[float] = []
        rets: list[float] = []
        for d, v in fg_hist.items():
            if not (lo <= v <= hi):
                continue
            if d in signal_counts:
                sig_vals.append(float(signal_counts[d]))
            i = kospi_idx.get(d)
            if i is not None and i + FWD_DAYS < len(kospi):
                rets.append((kospi[i + FWD_DAYS]["c"] / kospi[i]["c"] - 1) * 100)
        if not sig_vals and not rets:
            continue
        buckets.append({
            "label": en,
            "label_ko": ko,
            "lo": lo, "hi": hi,
            "n_days": len(sig_vals),
            "avg_signals": round(statistics.mean(sig_vals), 1) if sig_vals else None,
            "avg_21d_kospi_pct": round(statistics.mean(rets), 2) if rets else None,
            "median_21d_kospi_pct": round(statistics.median(rets), 2) if rets else None,
            "win_pct": round(len([x for x in rets if x > 0]) / len(rets) * 100, 1) if rets else None,
        })

    return {
        "buckets": buckets,
        "corr": corr,
        "n_days": len(fg_hist),
        "signal_days": len(pairs),
        "fwd_days": FWD_DAYS,
        "source": "GitHub kospi-feargreedindex (2022-03~, 배치 갱신)",
        "caveats": [
            "한국에는 공식 공포·탐욕 지수가 없다. 민간 서비스가 각각 계산하며 값이 다르다 "
            "(Supabase 18 / feargree-api 27, 2026-10-20 기준).",
            "GitHub 이력은 2개월 지연이 있다. 현재값이 아니라 통계 검증용이다.",
            "상관계수 부호가 반대인 이유: 한국 공포·탐욕 점수는 공포가 클수록 LOW 가 된다. "
            "점수가 낮을수록 매수 신호가 많다 = 음의 상관.",
            "표본 1087포인트는 2022-03 이후 한국 시장 1회차만 포함한다. "
            "구조적 변화(부동산 정책, 반도체 사이클 등)가 섞여 있다.",
        ],
    }


def main() -> None:
    refresh = "--refresh" in sys.argv
    print("한국 공포·탐욕 분석")

    fg_hist = fetch_kr_fg_history()
    kospi = fetch_kospi()
    print(f"  KOSPI {len(kospi)}봉")
    kr_hist = load_kr_etf_cache(refresh)

    if not fg_hist or not kospi or not kr_hist:
        raise SystemExit("한국 공포·탐욕 분석에 필요한 데이터가 부족합니다.")

    result = kr_analysis(kr_hist, fg_hist, kospi)

    # 기존 결과에 병합
    out: dict = {}
    if OUT.exists():
        try:
            out = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            out = {}
    out["kr"] = result
    out["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  → {OUT.relative_to(ROOT)}")
    print(f"  한국 공포탐욕 ↔ 신호수 상관: {result['corr']}")
    for b in result["buckets"]:
        print(f"    {b['label_ko']:12s} n={b['n_days']:4d} 신호 {b['avg_signals']}개 "
              f"KOSPI 21일 {b['avg_21d_kospi_pct']:+.2f}% 승률 {b['win_pct']}%")


if __name__ == "__main__":
    main()
