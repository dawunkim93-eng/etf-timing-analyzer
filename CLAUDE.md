# 작업 지침

이 저장소는 참고 사이트([sowt89/my-invest-analysis](https://sowt89.github.io/my-invest-analysis/))의
구조를 따르는 ETF 타이밍 분석 사이트다. 서버 없이 정적 파일만으로 돌아간다.

## 먼저 읽어야 할 것

`README.md` 의 "검증 결과" 절. 이 프로젝트의 핵심은 **주장이 아니라 측정값**이다.
설명에 적힌 숫자는 전부 `scripts/backtest.py` 가 만든다. 손으로 숫자를 고치면 안 된다.

## 규칙 상수는 한 곳에 있다

`scripts/universe.py` 의 상수 블록이 유일한 원본이다.

```python
SIGNAL_LOW_FROM_52W = 10.0
SIGNAL_RSI_MAX = 50.0
EXIT_RSI = 60.0
EXIT_RSI_STRICT = 70.0
STOP_LOSS = 0.15
MAX_HOLD_DAYS = 63
RSI_TIMEFRAME = "weekly"   # "weekly" | "daily"
RSI_PERIOD = 14             # 주봉이면 14주
WEEKLY_MIN_BARS = 15
```

**국면 판정** (`universe.py`)

```python
REGIME_METHOD = "lt20"      # "lt20" | "ret12"
REGIME_THRESHOLD = 20.0     # 고점/저점 대비 반전 %
REGIME_HISTORY_YEARS = 10   # 국면 판정용 벤치마크 이력
```

LT 규칙은 지수의 **전체 경로**가 필요하다(고점·저점 누적 추적).
2년치로는 2022년 하락장을 기억 못한다 → 국면 판정용 지수(`^GSPC`/`^KS11`)는
**따로 10년치**를 받는다. ETF 유니버스는 2년치 그대로.

**★ 시간프레임 혼합 금지 ★**
RSI 만 주봉이고, 52주 저·고점 / MA50 / MA200 / 수익률 / 낙폭은 **일봉 그대로**다.
의도된 설계다. 섞지 말 것.

**Fear & Greed** (`universe.py`)

```python
FG_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
FG_HISTORY_DAYS = 252       # CNN 이 주는 1년치뿐
FG_RATINGS = [("extreme fear", "극심한 공포"), ...]
FG_COMPONENTS = [("market_momentum_sp500", "S&P500 모멘텀"), ...]   # 8개
```

★ CNN 은 252일(1년)치만 준다. 10년 검증이 필요하면 **VIX 52주 고점 대비 비율**로
재구성한다 (`fear_greed_analysis.py`).
★ VIX 비율과 FG 점수는 **사실상 무관**하다(상관계수 +0.01). '변동성의 위치' 와
'심리지수' 는 다른 지표다. 설명서에 이 점을 반드시 남긴다.
★ CNN 이 같은 날짜를 두 번 주는 경우가 있다 → 날짜 기준으로 중복 제거.
★ 공포지수는 **매수 신호 판정에 쓰지 않는다.** 참고 지표다.
★ CNN 등급 경계는 0~25 / 25~45 / 45~55 / 55~75 / 75~100. 10점 단위로
자르면 등급이 깨진다.

**한국 공포·탐욕** (`universe.py`)

```python
KR_FG_URL = "https://giuxbisydiqiapugqqmq.supabase.co/storage/v1/object/public/news-data/fear-greed.json"
KR_FG_HISTORY_URL = "https://stockhub.kr/api/fear-greed/history"
KR_FG_GITHUB_URL = "https://raw.githubusercontent.com/immanuelk1m/kospi-feargreedindex/main/assets/js/json/index.json"
```

★ **한국에는 공식 공포·탐욕 지수가 없다.** KRX 는 VKOSPI 등 변동성 지수만
  공표하고, 공포·탐욕은 전부 **민간 서비스가 각각 계산**한다.
  그래서 소스마다 값이 다르다 (Supabase 18 / feargree-api 27).
  **서로 다른 서비스의 값을 섞거나 평균내지 않는다.**
★ Supabase 는 현재값만 있고 **이력이 없다**. 이력은 stockhub 에서 따로 받는다.
  둘은 같은 백엔드 (같은 날짜 us 값 일치 확인).
★ stockhub 은 **평일만 갱신**한다. 주말에 값이 고정 → 스파크라인에 평평한 구간.
★ GitHub 이력은 **2개월 지연**. 현재값으로 쓰지 않고 통계 검증 전용.
★ 점수→등급 경계는 0-24/25-44/45-54/55-74/75-100 (GitHub 지수와 동일).
★ 인증 불필요. 공개 버킷이고 CORS 가 `*` 다.

**이력 등급** (`universe.py`)

```python
MIN_BARS_STD = 252   # 52주 이상 → standard (52주 저점 규칙, 검증됨)
MIN_BARS_NEW = 130   # 26주 이상 → new (가용 이력 저점, 미검증)
                     # 미만 → insufficient (매수 신호로 승격 안 함)
```

신규 상장 ETF 도 52주 저점 규칙으로 처리할 수 있다 — 슬라이스가
`bars[-252:]` 이므로 252봉이 없으면 자동으로 '가용 이력 전체' 가 된다.
**26주가 경계인 이유**: 주봉 RSI(14) 가 15주 최소 이력을 필요로 하고,
가상 "상장 1년 ETF" 백테스트에서 26주 이상이면 평균 +9.80% / 승률 75.3%
(10년 ETF 와 동일) 인 반면 6주 미만은 평균 -3.37% / 승률 17.9% 다.

**유니버스 선정 규칙** (`universe.py`)

한국 ETF 는 **테마당 최대 2개**로 제한한다. 같은 테마에 몰리면 포트폴리오가
편중되고, 백테스트에서 이미 '한 업종 쏠림'을 한계로 명시하고 있다.

한국 ETF AUM 상위 45개를 전수 조사해 커버리지 못한 테마를 골랐다.
선정 시 제외한 후보와 사유는 `universe.py` 의 KR_ETFS 블록 주석에 있다:
  - 0080G0 KODEX 방산TOP10 — 방산이 이미 2개
  - 0167A0 SOL AI반도체TOP2플러스 — 147봉 = 미검증(new)
  - 0183J0 TIGER 미국우주테크 — 127봉 = insufficient, 신호 승격 불가
  - 364980 TIGER 2차전지TOP10 / 0098F0 KODEX 원자력SMR / 244580 KODEX 바이오
    — 각 테마가 이미 2개

**낙폭 버킷** (`universe.py` 의 `DEPTH_BUCKETS`) — 52주 고점 대비 낙폭 구간.
버킷 경계는 검증 결과(10년 백테스트)에 맞춰 정했다. 곡점은 30~35% 다.

```python
DEPTH_BUCKETS = [
    ("15% 미만",   0.0,  -15.0),
    ("15~20%",   -15.0, -20.0),
    ...
    ("40%+",     -40.0, -100.0),
]
DEPTH_SWEET_SPOT = "30~35%"
DEPTH_LOW_SAMPLE = 500
```

여기서 버킷을 고치면:
1. `fetch_etf.py` 의 `signal.depth_label` 이 바뀐다
2. `depth_analysis.py` 의 버킷별 성과가 다시 계산된다
3. `validate_data.py` 가 `depth_label` ↔ `from_high_pct` 일치를 검사한다

여기를 바꾸면:
1. `scripts/fetch_etf.py` 의 신호 판정이 따라 바뀐다
2. `scripts/backtest.py` 도 같은 값을 import 하므로 검증 결과가 따라 바뀐다
3. `scripts/validate_data.py` 가 `data/*.json` 의 `rules` 와 일치하는지 검사한다

**세 곳을 따로 고치면 검증이 설명과 어긋난다.**

## 알려진 함정 (실측해서 확인한 것)

1. **Yahoo 는 일반 HTTP 클라이언트를 429 로 막는다.**
   `curl_cffi` + `impersonate="chrome"` 만 통과한다. `requests` 로 바꾸지 말 것.

2. **Yahoo 메타의 `fiftyTwoWeekLow` 는 한국 ETF 에서 `0.0` 을 반환한다.**
   52주 저·고점은 일봉에서 직접 계산한다. (`fetch_etf.py` 의 `build_indicators`)

3. **52주 저점은 종가가 아니라 장중 저가다.**
   야후 meta 와 정확히 일치하는 쪽이 맞다 (SPY 629.28).
   종가로 계산하면 631.97 이 나온다.

4. **ETF 마다 상장일이 달라 봉 개수가 다르다.**
   백테스트에서 날짜 인덱스로 맞춰 접근하면 다른 날짜를 가리킨다.
   `portfolio_curve()` 는 날짜 문자열로만 처리한다.

5. **네이버 ETF 목록은 EUC-KR 인코딩이다.**
   `resp.content.decode('euc-kr')` 로 디코드해야 한글이 깨지지 않는다.

6. **백테스트 캐시(8MB)는 커밋하지 않는다.** `.gitignore` 에 있음.

7. **표본이 적은 구간을 지우지 않는다.**
   `depth_analysis.py` 는 n < 500 구간도 그대로 `data/depth.json` 에 쓴다.
   화면에 "저수표"로 표시해 사용자가 판단하게 하는 게 목적이다.
   표본을 걸러내면 편향이 숨겨진다.

8. **전반/후반 분할 기준은 고정 캘린저 날짜다.**
   신호일 중위로 나누면 표본 밀도(2022년 bear market)에 따라 자르게 된다.
   `depth_analysis.py` 의 `split_pivot` 는 전체 신호 구간의 캘린더 중위.

9. **주봉 RSI 매핑은 무목적이어야 한다.**
   주봉은 "그 주의 마지막 거래일" 에서 확정된다. 그래서 어떤 날짜 d 시점에
   쓸 수 있는 값은 **이미 지나간 주** 뿐이다.
   ```
   w_dates = [..., '10-09', '10-16', '10-19']
   d = '2026-10-19' → 쓸 수 있는 마지막 확정 주 = '10-16'
   ```
   정답은 `bisect_left(w_dates, d) - 1` 이다. `bisect_right` 를 쓰거나
   `j-1` 을 두 번 빼면 한 주씩 밀린다. 이 버그를 실제로 한 번 냈다.

10. **야후 일봉 배열의 마지막 봉은 실제 마지막 거래일보다 하루 밀린다.**
    meta 에는 오늘 거래분이 있지만 배열에는 없다. 그래서 `fetch_chart()` 가
    배열 끝에 meta 의 오늘 거래분을 **덧붙인다**. 붙이지 않으면 현재가가
    52주 저점 계산에서 빠지고 주봉 RSI 도 한 주 밀린다.

11. **국면을 1년 수익률로 판정하지 않는다.**
    "추세"가 아니라 "과거 대비" 다. 한국 KODEX 200 이 1년 +81.8% 여서
    "상승 국면" 으로 표시됐지만 실제로는 52주 고점 대비 -42.6%, 200일선 아래였다.
    `swing_regime()` (LT 20% 규칙) 을 쓴다.

12. **국면 판정은 날짜 기준이어야 한다.**
    `bear_flags[i]` 처럼 봉 인덱스로 접근하면 ETF 마다 상장일이 달라
    (XLC 는 2018-06) SPY 와 날짜가 어긋난다. `bench_regime_map()` 은
    날짜 → bool 딕셔너리를 반환한다.

## 탭 구조

```
매수 타이밍  — 신호만 (상단에 시장 요약 배지 → 시장 탭 이동)
익절 타이밍  — 익절/손절 기준 + 보유 종목 상태
시장          — 참고자료. 국면 · 공포·탐욕 · 벤치마크 · 공포지수↔신호 요약
전체 목록     — 70(미국)/50(한국)종목
검증          — 모든 백테스트 결과
설명서        — 규칙 · 계산 방법 · 한계
```

★ **매수 탭에 시장 맥락을 섞지 않는다.** 신호와 맥락은 별개다.
  매수 탭엔 1줄 요약 배지만 두고, 상세는 시장 탭으로 보낸다.
★ `renderFearGreedSummary()` 는 `data/feargreed.json` 이 **나중에** 로드된다.
  `loadBacktest()` 가 끝난 뒤에 다시 호출해야 빈 상태로 남지 않는다.

## 코드 관례

- 주석과 설명서는 **한국어**. 왜(why)를 쓴다.
- 프런트엔드는 **프레임워크 없음**. 바닐라 JS + 손으로 그린 SVG 차트.
- 파이썬은 `from __future__ import annotations` + 타입 힌트.
- 데이터는 JSON 을 git 에 커밋. DB 없음.
- 스크립트는 `python scripts/xxx.py` 로 직접 실행 가능해야 한다.

## 변경 후 반드시 할 것

```bash
python scripts/fetch_etf.py all
python scripts/validate_data.py
python scripts/backtest.py --refresh   # 백테스트 + 낙폭 + 공포지수(미국·한국) 분석을 함께 돌린다
```

`validate_data.py` 가 실패하면 배포하지 않는다. 신호 플래그가 원시값과
안 맞으면(저점+10%/RSI 50 조건) 화면이 거짓말을 하게 된다.

## 배포

- `main` 에 push → Pages 자동 재배포 (`.github/workflows/deploy-pages.yml`)
- 데이터는 30분 주기 cron 이 갱신 (`update-data.yml`)

## 도움 되는 명령

```bash
# 백테스트 결과만 다시 보기
python scripts/backtest.py

# 특정 시장만 수집
python scripts/fetch_etf.py kr

# 로컬 미리보기
python -m http.server 8000
```
