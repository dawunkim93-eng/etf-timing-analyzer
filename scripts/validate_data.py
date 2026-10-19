"""데이터 무결성 검사.

배포 전에 반드시 돌린다. 화면이 깨진 상태로 올라가는 걸 막는 것이 목적이다.
여기서 실패하면 워크플로가 멈추고 기존 데이터가 그대로 남는다.

用法:
    python scripts/validate_data.py
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from universe import MARKETS, SIGNAL_LOW_FROM_52W, SIGNAL_RSI_MAX  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
KST = timezone(timedelta(hours=9))

# 데이터가 이 시간보다 오래되면 경고 (장외 2시간 갱신 주기이므로 넉넉히 잡는다)
STALE_HOURS = 12

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def check_number(value, field: str, where: str, lo=None, hi=None) -> None:
    if value is None:
        return
    if not isinstance(value, (int, float)):
        err(f"{where}: {field} 가 숫자가 아님 ({value!r})")
        return
    if math.isnan(value) or math.isinf(value):
        err(f"{where}: {field} 이 NaN/Inf ({value!r})")
        return
    if lo is not None and value < lo:
        err(f"{where}: {field}={value} 가 하한({lo}) 아래")
    if hi is not None and value > hi:
        err(f"{where}: {field}={value} 가 상한({hi}) 위")


def validate_market(market: str) -> None:
    path = DATA_DIR / f"etf_{market}.json"
    if not path.exists():
        err(f"{path.name} 없음")
        return

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        err(f"{path.name}: JSON 파싱 실패 ({exc})")
        return

    where = path.name

    # --- 최상위 필드 ---
    for key in ("updated_at", "market", "etfs", "benchmark", "regime", "rules"):
        if key not in data:
            err(f"{where}: 최상위 필드 '{key}' 없음")

    if data.get("market") != market:
        err(f"{where}: market 값이 '{data.get('market')}' — '{market}' 이어야 함")

    # --- 갱신 신선도 ---
    upd = data.get("updated_at")
    if upd:
        try:
            ts = datetime.strptime(upd, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
            if age_h > STALE_HOURS:
                warn(f"{where}: 데이터가 {age_h:.1f} 시간 전 — 갱신 확인 필요")
        except ValueError:
            err(f"{where}: updated_at 형식 오류 ({upd!r})")

    # --- 국면 ---
    if data.get("regime") not in ("bull", "bear", None):
        err(f"{where}: regime 값이 '{data.get('regime')}' — bull/bear/None 이어야 함")

    bench = data.get("benchmark") or {}
    for key in ("ticker", "price", "ret_12m", "regime"):
        if key not in bench:
            err(f"{where}: benchmark 에 '{key}' 없음")

    # --- 규칙 상수 일치 ---
    rules = data.get("rules") or {}
    if rules.get("low_from_52w") != SIGNAL_LOW_FROM_52W:
        err(f"{where}: rules.low_from_52w={rules.get('low_from_52w')} ≠ {SIGNAL_LOW_FROM_52W}")
    if rules.get("rsi_max") != SIGNAL_RSI_MAX:
        err(f"{where}: rules.rsi_max={rules.get('rsi_max')} ≠ {SIGNAL_RSI_MAX}")

    # --- 종목 ---
    etfs = data.get("etfs") or []
    expected = len(MARKETS[market]["etfs"])  # type: ignore[index]
    if len(etfs) < expected * 0.8:
        err(f"{where}: 종목 {len(etfs)}개 — 정의된 {expected}개 중 80% 미만")

    seen: set[str] = set()
    for e in etfs:
        code = e.get("code", "?")
        w = f"{where}:{code}"
        if code in seen:
            err(f"{w}: ticker 중복")
        seen.add(code)

        for key in ("name", "category", "theme", "price", "low_52w", "high_52w",
                    "from_low_pct", "rsi", "ma200", "signal"):
            if key not in e:
                err(f"{w}: 필드 '{key}' 없음")

        check_number(e.get("price"), "price", w, lo=0)
        check_number(e.get("low_52w"), "low_52w", w, lo=0)
        check_number(e.get("high_52w"), "high_52w", w, lo=0)
        check_number(e.get("from_low_pct"), "from_low_pct", w, lo=-100, hi=1000)
        check_number(e.get("from_high_pct"), "from_high_pct", w, lo=-100, hi=1000)
        check_number(e.get("rsi"), "rsi", w, lo=0, hi=100)
        check_number(e.get("ma50"), "ma50", w, lo=0)
        check_number(e.get("ma200"), "ma200", w, lo=0)

        # 저점이 고점보다 높으면 데이터 오류
        lo52, hi52 = e.get("low_52w"), e.get("high_52w")
        if isinstance(lo52, (int, float)) and isinstance(hi52, (int, float)) and lo52 > hi52:
            err(f"{w}: 52주 저점({lo52}) > 고점({hi52})")

        # 현재가가 저점보다 아래면 안 된다
        px = e.get("price")
        if isinstance(px, (int, float)) and isinstance(lo52, (int, float)) and px < lo52 * 0.98:
            err(f"{w}: 현재가({px}) 가 52주 저점({lo52}) 아래")

        # 신호 플래그가 원시값과 일치해야 한다
        sig = e.get("signal") or {}
        low_pct, rsi = e.get("from_low_pct"), e.get("rsi")
        expect_raw = (
            low_pct is not None and rsi is not None
            and low_pct <= SIGNAL_LOW_FROM_52W and rsi <= SIGNAL_RSI_MAX
        )
        if sig.get("raw_pass") != expect_raw:
            err(f"{w}: signal.raw_pass={sig.get('raw_pass')} 인데 "
                f"계산값은 {expect_raw} (저점+{low_pct}%, RSI {rsi})")
        expect_reg = expect_raw and data.get("regime") == "bear"
        if sig.get("regime_pass") != expect_reg:
            err(f"{w}: signal.regime_pass={sig.get('regime_pass')} 인데 계산값은 {expect_reg}")

        # 스파크라인 길이
        spark = e.get("spark")
        if not isinstance(spark, list) or len(spark) < 2:
            err(f"{w}: spark 데이터 부족")

    print(f"  {market.upper()}: {len(etfs)}종목 · 국면 {data.get('regime')} · "
          f"raw_pass {sum(1 for e in etfs if (e.get('signal') or {}).get('raw_pass'))} · "
          f"regime_pass {sum(1 for e in etfs if (e.get('signal') or {}).get('regime_pass'))}")


def main() -> None:
    print("데이터 무결성 검사")
    for market in ("us", "kr"):
        validate_market(market)

    # history
    hist_path = DATA_DIR / "history.json"
    if hist_path.exists():
        try:
            hist = json.loads(hist_path.read_text(encoding="utf-8"))
            if not isinstance(hist, dict):
                err("history.json: 최상위가 객체가 아님")
            else:
                for day, rec in hist.items():
                    if not isinstance(rec, dict):
                        err(f"history.json: {day} 기록이 객체가 아님")
                    elif "m" not in rec:
                        err(f"history.json: {day} 에 'm' 없음")
                print(f"  HISTORY: {len(hist)}일 기록")
        except Exception as exc:  # noqa: BLE001
            err(f"history.json: 파싱 실패 ({exc})")

    for w in warnings:
        print(f"  [경고] {w}")
    if errors:
        print(f"\n[실패] {len(errors)}건")
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)
    print("\n[통과] 데이터 무결성 이상 없음")


if __name__ == "__main__":
    main()
