"""백테스트 — 사이트 "검증" 탭의 숫자를 만든다.

설명에 적힌 수치를 손으로 적지 않고 여기서 다시 계산한다.
설명과 숫자가 어긋나면 검증이 무의미해지므로, 결과는
data/backtest.json 으로 저장해 프런트엔드가 그대로 읽게 한다.

검증 대상 (미국 ETF 38종목, 2016-10 ~ 2026-10):
  매수 : 52주저점 대비 +10% 이내 AND RSI(14) <= 50
  매도 : RSI > 60 익절 (+15% 손절)  /  RSI > 70 익절 (+15% 손절)
  국면 : 벤치마크(SPY) 최근 252거래일 수익률 < 0 이면 약세

用法:
    python scripts/backtest.py            # 캐시가 있으면 캐시로
    python scripts/backtest.py --refresh  # 10년 일봉 다시 받기
"""

from __future__ import annotations

import json
import math
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import (  # noqa: E402
    BARS_FOR_52W,
    EXIT_RSI,
    EXIT_RSI_STRICT,
    MA_LONG,
    MARKETS,
    MAX_HOLD_DAYS,
    RSI_PERIOD,
    SIGNAL_LOW_FROM_52W,
    SIGNAL_RSI_MAX,
    STOP_LOSS,
    US_ETFS,
    yahoo_ticker,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE = DATA_DIR / ".backtest_cache.json"
OUT = DATA_DIR / "backtest.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
HISTORY_RANGE = "10y"


def rsi_series(closes: list[float], period: int = RSI_PERIOD) -> list[float | None]:
    """Wilder 평활 RSI 를 전체 시점에 대해 계산."""
    out: list[float | None] = [None] * len(closes)
    if len(closes) < period + 1:
        return out
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out[i + 1] = (
            100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
        )
    return out


def fetch_history(ticker: str) -> dict | None:
    import urllib.parse

    from curl_cffi import requests as cr

    session = cr.Session(impersonate="chrome", headers={"User-Agent": UA})
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}"
    for attempt in range(3):
        try:
            resp = session.get(
                url,
                params={"range": HISTORY_RANGE, "interval": "1d", "includePrePost": "false"},
                timeout=40,
            )
            if resp.status_code != 200:
                time.sleep(2.0 * (2 ** attempt))
                continue
            payload = resp.json().get("chart", {})
            rows = payload.get("result") or []
            if not rows:
                time.sleep(2.0 * (2 ** attempt))
                continue
            res = rows[0]
            stamps = res.get("timestamp") or []
            quote = (res.get("indicators", {}).get("quote") or [{}])[0]
            closes = quote.get("close") or []
            lows = quote.get("low") or []
            highs = quote.get("high") or []
            out = []
            for i, st in enumerate(stamps):
                c = closes[i] if i < len(closes) else None
                lo = lows[i] if i < len(lows) else None
                hi = highs[i] if i < len(highs) else None
                if c is None or lo is None or hi is None:
                    continue
                out.append(
                    {
                        "d": datetime.fromtimestamp(st, tz=timezone.utc).strftime("%Y-%m-%d"),
                        "c": float(c),
                        "lo": float(lo),
                        "hi": float(hi),
                    }
                )
            return {"ticker": ticker, "bars": out} if out else None
        except Exception:  # noqa: BLE001
            time.sleep(2.0 * (2 ** attempt))
    return None


def load_history(refresh: bool) -> dict[str, dict]:
    if not refresh and CACHE.exists():
        try:
            cached = json.loads(CACHE.read_text(encoding="utf-8"))
            if cached:
                print(f"  캐시 사용: {len(cached)}종목")
                return cached
        except Exception:  # noqa: BLE001
            pass

    tickers = [yahoo_ticker("us", code) for code, *_ in US_ETFS]
    print(f"  10년 일봉 수집: {len(tickers)}종목")

    def one(t: str):
        data = fetch_history(t)
        time.sleep(0.2)
        return t, data

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for t, data in ex.map(one, tickers):
            if data and len(data["bars"]) > BARS_FOR_52W:
                out[t] = data
                print(f"    {t:6s} {len(data['bars'])}봉")
            else:
                print(f"    {t:6s} 실패")

    CACHE.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"  캐시 저장: {CACHE.name} ({len(out)}종목)")
    return out


# ------------------------------------------------------------------ 시뮬
def prepare(hist: dict[str, dict]) -> dict[str, dict]:
    """각 종목의 파생 배열을 미리 계산."""
    prepared = {}
    for t, rec in hist.items():
        bars = rec["bars"]
        closes = [b["c"] for b in bars]
        lows = [b["lo"] for b in bars]
        highs = [b["hi"] for b in bars]
        prepared[t] = {
            "dates": [b["d"] for b in bars],
            "c": closes,
            "l": lows,
            "h": highs,
            "rsi": rsi_series(closes),
        }
    return prepared


def bench_regime_map(prep: dict[str, dict], bench: str) -> list[bool]:
    """각 날짜가 약세 국면인지. 벤치마크 252거래일 수익률 < 0."""
    b = prep.get(bench)
    if not b:
        return []
    closes = b["c"]
    flags = []
    for i in range(len(closes)):
        if i < BARS_FOR_52W:
            flags.append(False)
        else:
            base = closes[i - BARS_FOR_52W]
            flags.append(base > 0 and closes[i] / base - 1 < 0)
    return flags


def simulate(
    prep: dict[str, dict],
    bench: str,
    exit_rsi: float,
    bear_only: bool,
    stop: float | None = STOP_LOSS,
    hold_max: int = MAX_HOLD_DAYS,
) -> list[dict]:
    """매수 신호 → 청산까지 시뮬레이션. 종목별 1회 보유(중복 진입 없음)."""
    bear_flags = bench_regime_map(prep, bench)
    trades: list[dict] = []
    # 벤치마크 날짜 → 종가 (알파 계산용)
    bench_p = prep.get(bench)
    bench_close: dict[str, float] = {}
    bench_idx: dict[str, int] = {}
    if bench_p:
        bench_close = dict(zip(bench_p["dates"], bench_p["c"]))
        bench_idx = {d: i for i, d in enumerate(bench_p["dates"])}

    for t, p in prep.items():
        closes, lows, rsi = p["c"], p["l"], p["rsi"]
        n = len(closes)
        i = BARS_FOR_52W
        while i < n:
            r = rsi[i]
            if r is None:
                i += 1
                continue
            low52 = min(lows[i - BARS_FOR_52W + 1: i + 1])
            if closes[i] / low52 - 1 > SIGNAL_LOW_FROM_52W / 100 or r > SIGNAL_RSI_MAX:
                i += 1
                continue
            if bear_only:
                if i >= len(bear_flags) or not bear_flags[i]:
                    i += 1
                    continue

            entry = closes[i]
            ei = i
            exit_i = None
            reason = "만료"
            for j in range(i + 1, min(n, i + hold_max + 1)):
                cs = closes[j]
                if rsi[j] is not None and rsi[j] > exit_rsi:
                    exit_i, reason = j, f"RSI>{int(exit_rsi)}"
                    break
                if stop is not None and cs / entry - 1 <= -stop:
                    exit_i, reason = j, f"-{int(stop * 100)}%"
                    break
            if exit_i is None:
                exit_i = min(n - 1, i + hold_max)
            ret = (closes[exit_i] / entry - 1) * 100
            # 시장조정 알파 — 같은 기간 벤치마크 수익률을 뺀다
            alpha = None
            if bench_close:
                b0 = bench_close.get(p["dates"][ei])
                b1 = bench_close.get(p["dates"][exit_i])
                if b0 and b1:
                    alpha = ret - (b1 / b0 - 1) * 100
            trades.append(
                {
                    "ticker": t,
                    "entry_date": p["dates"][ei],
                    "exit_date": p["dates"][exit_i],
                    "entry": round(entry, 4),
                    "exit": round(closes[exit_i], 4),
                    "ret": round(ret, 4),
                    "alpha": round(alpha, 4) if alpha is not None else None,
                    "reason": reason,
                    "hold": exit_i - ei,
                    "entry_rsi": round(rsi[ei], 2),
                    "entry_from_low": round((entry / min(lows[ei - BARS_FOR_52W + 1: ei + 1]) - 1) * 100, 2),
                }
            )
            i = exit_i + 1
    return trades


def portfolio_curve(trades: list[dict], prep: dict[str, dict]) -> dict:
    """동시 보유 포트폴리오 — 신호가 걸린 ETF 를 균등 보유.

    날짜 축을 벤치마크(SPY)로 맞춘다. ETF 마다 상장일이 달라 봉 개수가
    다른데, 인덱스로 맞춰 접근하면 서로 다른 날짜를 가리켜 버린다.
    그래서 전부 날짜 문자열 기준으로만 처리한다.
    """
    if not trades:
        return {}

    # 종목별 날짜 → 인덱스
    idx_map: dict[str, dict[str, int]] = {
        t: {d: i for i, d in enumerate(p["dates"])} for t, p in prep.items()
    }
    # 날짜 → 종가 (캐시)
    close_map: dict[str, dict[str, float]] = {
        t: dict(zip(p["dates"], p["c"])) for t, p in prep.items()
    }

    # (종목, 진입일, 청산일)
    entries: list[tuple[str, str, str]] = [
        (tr["ticker"], tr["entry_date"], tr["exit_date"]) for tr in trades
    ]

    bench_p = prep.get("SPY") or next(iter(prep.values()))
    bench_dates = bench_p["dates"]
    all_dates = sorted({d for _, a, b in entries for d in (a, b)})
    if not all_dates:
        return {}
    lo_d, hi_d = all_dates[0], all_dates[-1]
    axis = [d for d in bench_dates if lo_d <= d <= hi_d]
    if len(axis) < 2:
        return {}

    eq = 1.0
    peak = 1.0
    max_dd = 0.0
    invested_days = 0
    max_concurrent = 0
    for k in range(len(axis) - 1):
        day = axis[k]
        nxt = axis[k + 1]
        active = [t for t, a, b in entries if a <= day < b]
        max_concurrent = max(max_concurrent, len(active))
        rets: list[float] = []
        for t in active:
            cm = close_map.get(t)
            if not cm:
                continue
            c0 = cm.get(day)
            c1 = cm.get(nxt)
            if c0 and c1:
                rets.append(c1 / c0 - 1)
        r = statistics.mean(rets) if rets else 0.0
        if rets:
            invested_days += 1
        eq *= 1 + r
        peak = max(peak, eq)
        max_dd = min(max_dd, eq / peak - 1)

    invested_pct = round(invested_days / max(len(axis) - 1, 1) * 100, 1)

    years = max(len(axis) / 252, 1 / 252)
    bench_c = bench_p["c"]
    i0 = bench_p["dates"].index(axis[0])
    i1 = bench_p["dates"].index(axis[-1])
    bench_ret = bench_c[i1] / bench_c[i0] - 1 if bench_c[i1] else 0.0
    return {
        "final": round(eq, 4),
        "cagr_pct": round((eq ** (1 / years) - 1) * 100, 2),
        "max_dd_pct": round(max_dd * 100, 2),
        "trades": len(trades),
        "start": axis[0],
        "end": axis[-1],
        "years": round(years, 2),
        "invested_pct": invested_pct,
        "max_concurrent": max_concurrent,
        "bench_final": round(1 + bench_ret, 4),
        "bench_cagr_pct": round(((1 + bench_ret) ** (1 / years) - 1) * 100, 2),
        "bench_max_dd_pct": round(max_dd_bench(bench_c, i0, i1) * 100, 2),
    }


def max_dd_bench(closes: list[float], lo: int, hi: int) -> float:
    pk = -1e18
    md = 0.0
    for v in closes[lo: hi + 1]:
        pk = max(pk, v)
        md = min(md, v / pk - 1)
    return md


def random_control(prep: dict[str, dict], n: int = 20000, seed: int = 42) -> dict:
    """무작위 진입 대조군 — 같은 날짜 구간에서 랜덤으로 들어갔을 때."""
    rnd_gen = random.Random(seed)
    rets: list[float] = []
    for t, p in prep.items():
        closes, lows, rsi = p["c"], p["l"], p["rsi"]
        ln = len(closes)
        for i in range(BARS_FOR_52W, ln - 63):
            if rsi[i] is None:
                continue
            low52 = min(lows[i - BARS_FOR_52W + 1: i + 1])
            if closes[i] / low52 - 1 > SIGNAL_LOW_FROM_52W / 100 or rsi[i] > SIGNAL_RSI_MAX:
                continue
            j = rnd_gen.randint(max(BARS_FOR_52W, i - 63), min(ln - 64, i + 63))
            rets.append((closes[j + 63] / closes[j] - 1) * 100)
            if len(rets) >= n:
                break
        if len(rets) >= n:
            break
    if not rets:
        return {}
    return {
        "n": len(rets),
        "avg_pct": round(statistics.mean(rets), 3),
        "win_pct": round(len([x for x in rets if x > 0]) / len(rets) * 100, 2),
    }


def summarize(trades: list[dict]) -> dict:
    if not trades:
        return {}
    rets = [t["ret"] for t in trades]
    reasons: dict[str, dict] = {}
    for t in trades:
        r = reasons.setdefault(t["reason"], {"n": 0, "sum": 0.0, "win": 0})
        r["n"] += 1
        r["sum"] += t["ret"]
        r["win"] += 1 if t["ret"] > 0 else 0
    for r in reasons.values():
        r["avg_pct"] = round(r["sum"] / r["n"], 2)
        r["win_pct"] = round(r["win"] / r["n"] * 100, 1)
    alphas = [t["alpha"] for t in trades if t.get("alpha") is not None]
    return {
        "n": len(trades),
        "avg_pct": round(statistics.mean(rets), 3),
        "median_pct": round(statistics.median(rets), 3),
        "win_pct": round(len([x for x in rets if x > 0]) / len(rets) * 100, 2),
        "avg_hold": round(statistics.mean([t["hold"] for t in trades]), 1),
        "alpha_avg_pct": round(statistics.mean(alphas), 3) if alphas else None,
        "alpha_win_pct": (
            round(len([x for x in alphas if x > 0]) / len(alphas) * 100, 2) if alphas else None
        ),
        "reasons": reasons,
    }


def main() -> None:
    refresh = "--refresh" in sys.argv
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("백테스트")
    hist = load_history(refresh)
    if not hist:
        raise SystemExit("일봉을 못 받아서 백테스트를 돌릴 수 없습니다.")

    prep = prepare(hist)
    bench = "SPY"
    if bench not in prep:
        bench = next(iter(prep))

    variants = {}
    combos = [
        ("rsi60_plain", EXIT_RSI, False),
        ("rsi60_plain_bear", EXIT_RSI, True),
        ("rsi70_plain", EXIT_RSI_STRICT, False),
        ("rsi70_plain_bear", EXIT_RSI_STRICT, True),
    ]
    for key, rx, bear_only in combos:
        trades = simulate(prep, bench, rx, bear_only)
        variants[key] = {
            "exit_rsi": rx,
            "bear_only": bear_only,
            "trade_stats": summarize(trades),
            "portfolio": portfolio_curve(trades, prep),
        }
        s = variants[key]["trade_stats"]
        p = variants[key]["portfolio"]
        print(
            f"  {key:22s} n={s.get('n', 0):5d} avg={s.get('avg_pct', 0):+7.2f}% "
            f"win={s.get('win_pct', 0):5.1f}% | 포트폴리오 {p.get('final', 0):.2f}배 "
            f"연 {p.get('cagr_pct', 0):+6.2f}% MDD {p.get('max_dd_pct', 0):6.1f}%"
        )

    ctrl = random_control(prep)
    print(f"  {'무작위 대조군':22s} n={ctrl.get('n', 0):5d} avg={ctrl.get('avg_pct', 0):+7.2f}% "
          f"win={ctrl.get('win_pct', 0):5.1f}%")

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "universe": [t for t in prep],
        "universe_size": len(prep),
        "history_range": HISTORY_RANGE,
        "benchmark": bench,
        "rules": {
            "low_from_52w": SIGNAL_LOW_FROM_52W,
            "rsi_max": SIGNAL_RSI_MAX,
            "exit_rsi": EXIT_RSI,
            "exit_rsi_strict": EXIT_RSI_STRICT,
            "stop_loss": STOP_LOSS,
            "max_hold_days": MAX_HOLD_DAYS,
            "bear_rule": "벤치마크 252거래일 수익률 < 0",
        },
        "variants": variants,
        "random_control": ctrl,
        "disclaimer": (
            "생존 편향 없는 유니버스가 아니다 — 지금 살아있는 ETF 로 돌아간다. "
            "이 ETF 중 상장폐지된 것(예: 3X ETF 다수)의 과거 주가는 이 표본에 없다."
        ),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  → {OUT.relative_to(ROOT)}")

    # 낙폭 축 분석 — 같은 일봉 캐시로 같이 계산한다 (추가 수집 없음)
    try:
        from depth_analysis import build_depth_analysis

        depth = build_depth_analysis(prep, bench)
        depth_out = DATA_DIR / "depth.json"
        depth_out.write_text(
            json.dumps(depth, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        print(f"  → {depth_out.relative_to(ROOT)}")
        for b in depth["buckets"]:
            mark = " ★" if b["sweet_spot"] else (" !" if b["low_sample"] else "")
            print(
                f"    {b['label']:>10s} n={b['n']:6d} 평균 {b['avg_pct']:+7.2f}% "
                f"승률 {b['win_pct']:5.1f}% 알파 {(b['alpha_pct'] or 0):+6.2f}{mark}"
            )
    except Exception as exc:  # noqa: BLE001
        print(f"  ! 낙폭 분석 실패 (기존 백테스트 결과는 정상): {exc}")


if __name__ == "__main__":
    main()
