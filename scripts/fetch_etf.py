"""ETF 시세 수집 + 지표 계산.

실측해서 정한 것들 (아래 주석이 아니라 실제로 확인한 값):

- 야후 일봉은 ``query2.finance.yahoo.com/v8/finance/chart/{티커}``.
  일반 requests 로는 429 로 막히므로 curl_cffi 의 브라우저 TLS 지문
  (impersonate="chrome")을 쓴다.
- 야후 meta 의 ``fiftyTwoWeekLow`` 는 **한국 ETF 에서 0.0 을 돌려준다**.
  그래서 52주 저·고점은 일봉에서 직접 계산한다.
  252거래일의 intraday low/high 를 쓴다 (야후 meta 와 정확히 일치 확인).
- RSI(14)는 Wilder 평활. 6개월/1년/2년 어떤 구간으로 계산해도
  같은 값이 나오므로 구간은 무관하다.
- 반응형 차트용으로 최근 120일 종가를 함께 저장한다.

用法:
    python scripts/fetch_etf.py [us|kr|all]
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import (  # noqa: E402
    BEAR_LOOKBACK,
    BARS_FOR_52W,
    DEPTH_SWEET_SPOT,
    MA_LONG,
    MA_SHORT,
    MARKETS,
    RSI_PERIOD,
    RSI_TIMEFRAME,
    SIGNAL_LOW_FROM_52W,
    SIGNAL_RSI_MAX,
    WEEKLY_MIN_BARS,
    depth_bucket,
    yahoo_ticker,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{ticker}"
KST = timezone(timedelta(hours=9))

# 수집 설정
FETCH_WORKERS = 6      # 동시 요청. 더 올리면 429 로 막힌다.
FETCH_GAP = 0.25       # 요청 사이 최소 간격(초)
FETCH_TRIES = 3        # 재시도 횟수
CHART_RANGE = "2y"     # 252거래일 + MA200 계산 여유
MAX_WORKERS_HARD = 8


# --------------------------------------------------------------------- 유틸
def rnd(x, d=2):
    """NaN/Inf/문자를 전부 None 으로 바꾼다. JSON 에 null 이 들어가도
    프런트엔드가 NaN 으로 화면을 깨먹지 않게 하는 장치."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, d)


def make_session():
    """야후 접속용 세션. 브라우저 지문이 막히면 일반 세션으로 폴백."""
    try:
        from curl_cffi import requests as cr
    except ImportError:
        raise SystemExit("curl_cffi 가 필요합니다: pip install -r requirements.txt")

    try:
        s = cr.Session(impersonate="chrome", headers={"User-Agent": UA})
        s.get(
            CHART_URL.format(ticker="SPY") + "?range=1d&interval=1d", timeout=15
        ).raise_for_status()
        print("session: curl_cffi (impersonate=chrome)")
        return s
    except Exception as exc:  # noqa: BLE001
        print(f"session: curl_cffi plain ({type(exc).__name__})")
        return cr.Session(headers={"User-Agent": UA})


def fetch_chart(session, ticker: str, rng: str = CHART_RANGE, interval: str = "1d"):
    """야후 일봉.

    반환: {"bars": [{date, close, low, high}], "meta_price", "meta_date", "meta_time"}
    실패하면 None.
    """
    import urllib.parse

    last_err: Exception | None = None
    for attempt in range(FETCH_TRIES):
        try:
            url = CHART_URL.format(ticker=urllib.parse.quote(ticker))
            resp = session.get(
                url,
                params={"range": rng, "interval": interval, "includePrePost": "false"},
                timeout=30,
            )
            if resp.status_code != 200:
                last_err = RuntimeError(f"HTTP {resp.status_code}")
                time.sleep(2.0 * (2 ** attempt))
                continue
            payload = resp.json().get("chart", {})
            if payload.get("error"):
                last_err = RuntimeError(f"chart error {payload['error']}")
                time.sleep(2.0 * (2 ** attempt))
                continue
            rows = payload.get("result") or []
            if not rows:
                last_err = RuntimeError("empty result")
                time.sleep(2.0 * (2 ** attempt))
                continue
            res = rows[0]
            meta = res.get("meta") or {}
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
                if not isinstance(c, (int, float)):
                    continue
                out.append(
                    {
                        "date": datetime.fromtimestamp(st, tz=timezone.utc).strftime("%Y-%m-%d"),
                        "close": float(c),
                        "low": float(lo),
                        "high": float(hi),
                    }
                )
            if not out:
                return None
            # 야후 일봉 배열의 마지막 봉은 실제 마지막 거래_session 보다
            # 하루씩 밀려 있다 (2026-10-20 기준 meta 는 10-19 종가인데
            # 배열은 10-16 까지만 있다). 가격 표시는 meta 를 쓴다.
            meta_price = meta.get("regularMarketPrice")
            meta_time = meta.get("regularMarketTime")
            meta_date = None
            if isinstance(meta_time, (int, float)):
                meta_date = dt.datetime.fromtimestamp(
                    meta_time, tz=dt.timezone.utc
                ).strftime("%Y-%m-%d")
            return {
                "bars": out,
                "meta_price": float(meta_price) if isinstance(meta_price, (int, float)) else None,
                "meta_date": meta_date,
                "meta_time": meta_time,
            }
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(2.0 * (2 ** attempt))
    print(f"    ! {ticker} 수집 실패: {last_err}")
    return None


# ------------------------------------------------------------- 지표 계산
def wilder_rsi(closes: list[float], period: int = RSI_PERIOD) -> float | None:
    """Wilder 평활 RSI. 야후/참고 사이트와 같은 계산."""
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def rsi_series(closes: list[float], period: int = RSI_PERIOD) -> list[float | None]:
    """각 시점의 RSI 를 한 번에 계산 (백테스트·그래프용)."""
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


def to_weekly(bars: list[dict]) -> list[dict]:
    """일봉 → 주봉. ISO 주(월~금) 로 묶고 각 주 마지막 거래일만 남긴다.

    isocalendar() 의 (연도, 주차) 를 키로 쓰면, 월요일이 다른 주의 시작이 되는
    문제를 피할 수 있다. 단순히 5일 단위로 자르면 경계가 어긋난다.
    """
    weeks: dict[tuple[int, int], dict] = {}
    for b in bars:
        d = dt.date.fromisoformat(b["date"])
        weeks[d.isocalendar()[:2]] = b   # 마지막 encountered = 그 주의 마지막 거래일
    return [weeks[k] for k in sorted(weeks)]


def weekly_rsi_lookup(bars: list[dict]) -> tuple[dict[str, float | None], str | None, list]:
    """날짜 → 확정된 주봉 RSI 매핑을 만든다.

    ★ 미래정보 주의 ★
    주봉 RSI 는 그 주가 끝나야 확정된다. 주중에 "이번 주 RSI" 를 계산하면
    아직 오지 않은 날짜의 데이터가 들어간다. 그래서 어떤 날짜에서든
    **이미 끝난** 마지막 주봉만 쓴다 (bisect_left).

    반환: (날짜→RSI 매핑, 마지막 확정 주봉의 기준일, 주봉 RSI 리스트)
    """
    weekly = to_weekly(bars)
    w_dates = [b["date"] for b in weekly]
    w_rsi = rsi_series([b["close"] for b in weekly], RSI_PERIOD)
    # ★ 무목적 주봉 매핑 ★
    # 주봉의 날짜 w 는 "그 주의 마지막 거래일" 이다.
    # 어떤 날짜 d 시점에 쓸 수 있는 값은 **이미 지나간 주** 뿐이다.
    #   w < d  → 그 주는 끝났다 → 확정값 사용 가능
    #   w == d → 그 주는 오늘 끝난다 → 아직 확정 아님 (같은 날 장중이면 미래)
    #
    #   w_dates = [..., '10-09', '10-16', '10-19']
    #   d = '2026-10-19' (월) → 쓸 수 있는 마지막 확정 주 = '10-16' (금)
    #
    # bisect_left(w_dates, d) 는 'd 이상인 첫 위치' 다.
    #   - d 가 w_dates 에 있으면 → 그 인덱스가 미확정 주, 직전이 답 (j-1)
    #   - d 가 없으면          → j 가 'd 보다 큰 첫 위치', 직전이 답 (j-1)
    # 두 경우 모두 답은 j-1 이다.
    def last_completed_idx(d: str) -> int:
        return bisect.bisect_left(w_dates, d) - 1

    lookup: dict[str, float | None] = {}
    for b in bars:
        j = last_completed_idx(b["date"])
        lookup[b["date"]] = w_rsi[j] if j >= 0 else None
    # 마지막 확정 주봉의 기준일
    last_idx = last_completed_idx(bars[-1]["date"])
    base_date = w_dates[last_idx] if last_idx >= 0 else None

    return lookup, base_date, w_rsi


def sma(values: list[float], n: int) -> float | None:
    if len(values) < n:
        return None
    return sum(values[-n:]) / n


def pct_change(a: float, b: float) -> float | None:
    """a 에서 b 로 얼마나 올랐는지(%)."""
    if not a:
        return None
    return (b / a - 1.0) * 100.0


def build_indicators(bars: list[dict], market_meta: dict, raw: dict | None = None) -> dict:
    """일봉 → 화면/신호에 필요한 지표.

    ★ 지표 시간프레임 ★
    - RSI      : 주봉 (확정된 마지막 주)
    - 나머지   : 일봉 (52주 저·고점, MA50/200, 수익률, 낙폭)

    야후 일봉 배열의 마지막 봉은 실제 마지막 거래일보다 하루 밀려 있다.
    그래서 '현재가' 는 meta 의 regularMarketPrice 를 쓴다.
    단, 지표(저·고점, MA, RSI)는 일봉 배열 그대로 계산한다 — 배열이
    어제까지여도 지표는 거기까지의 값으로 일관된다.
    """
    closes = [b["close"] for b in bars]
    lows = [b["low"] for b in bars]
    highs = [b["high"] for b in bars]
    dates = [b["date"] for b in bars]
    px = closes[-1]
    # 표시용 현재가 — meta 우선 (일봉 배열보다 하루 신선)
    meta_price = (raw or {}).get("meta_price")
    meta_date = (raw or {}).get("meta_date")
    display_px = meta_price if isinstance(meta_price, (int, float)) and meta_price else px

    win = bars[-BARS_FOR_52W:]
    low_52w = min(b["low"] for b in win)
    high_52w = max(b["high"] for b in win)

    ma50 = sma(closes, MA_SHORT)
    ma200 = sma(closes, MA_LONG)

    # --- RSI: 주봉 기준 (무목적) ---
    # 판정에 쓰는 rsi 는 주봉 확정값이다. 일봉 RSI 는 참고용으로 함께 둔다.
    rsi_daily = wilder_rsi(closes)
    w_lookup, w_base_date, w_rsi_series = weekly_rsi_lookup(bars)
    rsi = w_lookup.get(dates[-1])
    rsi_weekly_raw = w_rsi_series[-1] if w_rsi_series else None
    # 주봉 RSI 이력 (스파크라인용) — 확정된 주봉만
    weekly_bars = to_weekly(bars)
    weekly_dates = [b["date"] for b in weekly_bars]
    weekly_rsi_hist = [
        (d, v) for d, v in zip(weekly_dates, w_rsi_series) if v is not None
    ]

    # 기간 수익률 — 거래일 개수 기준 (달력일이 아니라)
    def ret_n(n: int) -> float | None:
        if len(closes) <= n:
            return None
        return pct_change(closes[-1 - n], px)

    ytd = None
    year_now = int(dates[-1][:4])
    base = next((c for c, d in zip(closes, dates) if d[:4] == str(year_now)), None)
    if base:
        ytd = pct_change(base, px)

    from_low = pct_change(low_52w, px)
    from_high = pct_change(high_52w, px)

    # 시장 국면: 벤치마크 1년 수익률이 음수면 약세
    regime = None
    regime_ret = None
    if len(closes) > BEAR_LOOKBACK:
        regime_ret = pct_change(closes[-1 - BEAR_LOOKBACK], px)
        regime = "bear" if (regime_ret is not None and regime_ret < 0) else "bull"

    return {
        "price": rnd(display_px),
        "price_series_date": dates[-1],
        "date": meta_date or dates[-1],
        "low_52w": rnd(low_52w),
        "high_52w": rnd(high_52w),
        "from_low_pct": rnd(from_low),
        "from_high_pct": rnd(from_high),
        "rsi": rnd(rsi, 1),
        "rsi_daily": rnd(rsi_daily, 1),
        "rsi_weekly_date": w_base_date,
        "rsi_weekly_raw": rnd(rsi_weekly_raw, 1),
        "rsi_timeframe": RSI_TIMEFRAME,
        "ma50": rnd(ma50),
        "ma200": rnd(ma200),
        "ma200_dist_pct": rnd(pct_change(ma200, px)) if ma200 else None,
        "ma50_above_ma200": bool(ma50 and ma200 and ma50 > ma200),
        "ret_1m": rnd(ret_n(21)),
        "ret_3m": rnd(ret_n(63)),
        "ret_6m": rnd(ret_n(126)),
        "ret_12m": rnd(ret_n(252)),
        "ytd": rnd(ytd),
        "bars_count": len(bars),
        # 최근 120일 종가·RSI — 스파크라인 + 매도 대시보드용
        "spark": [rnd(c) for c in closes[-120:]],
        "spark_dates": dates[-120:],
        "rsi_hist": [rnd(v, 1) for _, v in weekly_rsi_hist[-60:]],
        "rsi_hist_dates": [d for d, _ in weekly_rsi_hist[-60:]],
    }


def apply_signal(etf: dict, regime: str | None) -> dict:
    """매수 신호 판정.

    raw_pass  : 52주저점+10% 이내 AND RSI<=50  (사용자가 정한 원조건)
    regime_pass: raw_pass AND 시장이 약세 국면   (백테스트에서 강했던 조건)

    ★ RSI 는 주봉 확정값이다 (etf["rsi"]). 일봉 값은 etf["rsi_daily"] 에
    참고용으로 따로 담아둔다. 판정에는 쓰지 않는다.
    """
    low_pct = etf.get("from_low_pct")
    rsi = etf.get("rsi")
    raw = (
        low_pct is not None
        and rsi is not None
        and low_pct <= SIGNAL_LOW_FROM_52W
        and rsi <= SIGNAL_RSI_MAX
    )
    bucket = depth_bucket(etf.get("from_high_pct"))
    etf["signal"] = {
        "raw_pass": bool(raw),
        "regime_pass": bool(raw and regime == "bear"),
        "distance_to_low_pct": rnd(low_pct) if low_pct is not None else None,
        "rsi_gap": rnd(SIGNAL_RSI_MAX - rsi) if rsi is not None else None,
        # 52주 고점 대비 낙폭 버킷 — 순위 재배치가 아니라 정보 표기용
        "depth_label": bucket,
        "depth_sweet_spot": bucket == DEPTH_SWEET_SPOT,
    }
    return etf


# --------------------------------------------------------------------- 수집
def collect_market(market: str, session) -> dict:
    meta = MARKETS[market]
    rows = meta["etfs"]  # type: ignore[index]
    print(f"\n=== {market.upper()} · {len(rows)}종목 수집 ===")

    tickers = [f"{code}{meta['yahoo_suffix']}" for code, *_ in rows]  # type: ignore[index]
    results: dict[str, list[dict] | None] = {}

    def one(t: str):
        data = fetch_chart(session, t)
        time.sleep(FETCH_GAP)
        return t, data

    with ThreadPoolExecutor(max_workers=min(FETCH_WORKERS, MAX_WORKERS_HARD)) as ex:
        for t, data in ex.map(one, tickers):
            results[t] = data

    # 벤치마크 — 국면 판정 기준
    bench_t = f"{meta['benchmark']}{meta['yahoo_suffix']}"  # type: ignore[index]
    bench_raw = results.get(bench_t) or fetch_chart(session, bench_t)
    benchmark: dict = {}
    regime = None
    if bench_raw:
        bi = build_indicators(bench_raw["bars"], meta, bench_raw)
        regime = "bear" if (bi.get("ret_12m") is not None and bi["ret_12m"] < 0) else "bull"
        benchmark = {
            "ticker": meta["benchmark"],  # type: ignore[index]
            "name": meta["benchmark_name"],  # type: ignore[index]
            "price": bi["price"],
            "date": bi["date"],
            "ret_12m": bi["ret_12m"],
            "from_high_pct": bi["from_high_pct"],
            "ma200": bi["ma200"],
            "ma200_above": bi["ma200_dist_pct"] is not None and bi["ma200_dist_pct"] > 0,
            "rsi": bi["rsi"],
            "regime": regime,
        }
    else:
        print("  ! 벤치마크 수집 실패 — 국면 판정 불가 (신호는 raw_pass 로만 표시)")

    etfs: list[dict] = []
    failed: list[str] = []
    for code, name, category, theme in rows:
        t = f"{code}{meta['yahoo_suffix']}"
        raw = results.get(t)
        bars = raw["bars"] if raw else None
        if not bars or len(bars) < BARS_FOR_52W:
            failed.append(code)
            print(f"  [{len(etfs) + len(failed):2d}/{len(rows)}] {code:7s} 실패 (봉 {len(bars) if bars else 0})")
            continue
        ind = build_indicators(bars, meta, raw)
        row = {
            "code": code,
            "ticker": code,
            "yahoo": t,
            "name": name,
            "category": category,
            "theme": theme,
            "currency": meta["currency_label"],  # type: ignore[index]
        }
        row.update(ind)
        etfs.append(apply_signal(row, regime))
        print(
            f"  [{len(etfs) + len(failed):2d}/{len(rows)}] {code:7s} "
            f"{str(ind['price']):>12s} 저점+{str(ind['from_low_pct']):>6s}% "
            f"RSI {str(ind['rsi']):>5s} {'✔' if row['signal']['raw_pass'] else ''}"
        )

    ok_ratio = len(etfs) / len(rows) if rows else 0
    if ok_ratio < 0.6:
        raise SystemExit(f"성공 {len(etfs)}/{len(rows)} — 60% 미만이라 저장하지 않습니다.")

    now = datetime.now(timezone.utc)
    return {
        "updated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updated_at_kst": now.astimezone(KST).strftime("%Y-%m-%d %H:%M"),
        "market": market,
        "currency": meta["currency"],  # type: ignore[index]
        "currency_label": meta["currency_label"],  # type: ignore[index]
        "benchmark": benchmark,
        "regime": regime,
        "etfs": etfs,
        "failed": failed,
        "rules": {
            "low_from_52w": SIGNAL_LOW_FROM_52W,
            "rsi_max": SIGNAL_RSI_MAX,
            "rsi_timeframe": RSI_TIMEFRAME,
            "rsi_period": RSI_PERIOD,
        },
    }


def save_history(payload: dict) -> None:
    """일별 스냅샷 누적 — "오늘부터 쌓는 실제 기록".

    참고 사이트가 하듯, 당일 신호 종목의 지수를 저장해 나중에
    전략 성적을 지수와 비교할 수 있게 한다."""
    path = DATA_DIR / "history.json"
    hist: dict = {}
    if path.exists():
        try:
            hist = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            hist = {}
    today = datetime.now(KST).strftime("%Y-%m-%d")
    snap: dict = {"m": {}}
    for e in payload["etfs"]:
        if e["signal"]["raw_pass"]:
            snap["m"][e["code"]] = {
                "px": e["price"],
                "rl": e["from_low_pct"],
                "rsi": e["rsi"],
                "regime": e.get("regime_pass"),
            }
    snap["m"] = snap["m"]
    hist[today] = snap
    # 3년 보관
    cutoff = (datetime.now(KST) - timedelta(days=1095)).strftime("%Y-%m-%d")
    hist = {k: v for k, v in hist.items() if k >= cutoff}
    path.write_text(
        json.dumps(hist, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    print(f"  history: {len(hist)}일 기록, 오늘 신호 {len(snap['m'])}종목")


def main() -> None:
    args = sys.argv[1:] or ["all"]
    markets = ["us", "kr"] if args[0] == "all" else [args[0]]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    session = make_session()

    for market in markets:
        payload = collect_market(market, session)
        out = ROOT / str(MARKETS[market]["out"])  # type: ignore[index]
        out.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        size = out.stat().st_size
        print(f"  → {out.relative_to(ROOT)} ({size / 1024:.1f} KB, {len(payload['etfs'])}종목)")
        save_history(payload)


if __name__ == "__main__":
    main()
