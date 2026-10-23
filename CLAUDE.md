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

한국 ETF 는 **테마 수 제한이 없다** (2026-10 사용자 결정).
같은 지수 계열이 여러 개 들어갈 수 있다 (S&P500 3개, 나스닥100 5개 등).
포트폴리오 편중 위험은 '한계' 절에 명시.

단 **커버드콜은 별도 테마로 분리**했다. 옵션 기반 수익 전략이라 52주 저점
기준이 지수가 아니라 전략 NAV 저점이고 상승 참여도가 낮다.
화면에서 주석을 단다 (`app.js` 의 `isCoveredCall`).

한국 ETF AUM 상위 45개를 전수 조사해 커버리지 못한 테마를 골랐다.
선택 시 제외한 후보와 사유는 `universe.py` 의 KR_ETFS 블록 주석에 있다:
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

13. **이름 span 이 아니라 "셀 기준" 으로 넘침을 재야 한다.**
    전체 목록 표의 고정 열에서 이름 span 의 `scrollWidth` 만 재면
    "잘림 0" 으로 통과해 버린다. 실제로는 span 이 `td` 내용 우측을
    넘어 **옆 컬럼 위로** 그려지고 있었다 (한국 67/67 최대 24px,
    미국 70/70 최대 19px).
    ```
    ✗ name.scrollWidth > name.clientWidth          // span 기준 → 놓침
    ✓ name.getBoundingClientRect().right
      > td.getBoundingClientRect().right - paddingRight   // 셀 기준 → 잡힘
    ```
    원인은 이름 폭을 px 로 고정하면서 티커(~40px)를 빼먹은 것.
    `td` 를 `display:flex` 로 만들어 이름이 남은 폭을 자동 배분하게
    해결했다 (`.c` = `flex:0 0 auto`, `.mute` = `flex:1 1 auto;min-width:0`).
    ★ `td` 가 flex 컨테이너가 되어도 `position:sticky` 는 유지된다 (실측).

14. **`overflow-x:auto` 안의 `position:sticky` 는 페이지가 아니라 그 컨테이너 기준이다.**
    `.table-wrap` 이 `overflow-x:auto` 라 CSS 규칙상 **`overflow-y` 도 `auto` 로 계산**된다
    (한 축이 `visible` 이 아니면 다른 축도 `visible` 유지 불가).
    그래서 `thead` 의 `position:sticky; top:0` 이 **먹히지 않는다** —
    기준점이 페이지가 아니라 `.table-wrap` 이 되고, 거기가 세로로 스크롤하지
    않으니까(높이 auto) 고정 효과 0. 실측: 스크롤 시 thead top 이 668 → -532 로 그냥 사라짐.
    ★ `border-collapse:collapse` + sticky `th` 는 Chrome 이 border 를 제자리에
      남긴다. `th` 의 `border-bottom` 이 헤더 **상단**에 잘못 그려지고(실측 670px)
      헤더 아래 구분선이 사라진다 → `border-bottom:none` +
      `box-shadow: inset 0 -1px 0 var(--line)` 로 대체.
    ★ 참고: sowt89/my-invest-analysis 는 `th{position:sticky;top:0}` 을 쓰는데
      **그 표도 가로 스크롤 컨테이너 안에 있다** → 실제로는 고정되지 않는다.
      같은 CSS 를 복사하면 안 된다.
    ★ `.card{overflow:hidden}` 도 sticky 기준점을 바꾼다. 카드 안에 있는
      sticky 는 카드를 기준으로 움직인다(카드는 안 스크롤되므로 무효).

15. **★ 전체 목록 표의 구조적 제약 ★**
    ```
    11열 유지  →  가로 스크롤 필요  →  표를 감싼 박스가 스크롤 컨테이너
                                     →  헤더를 화면에 고정할 수 없음
    5열로 축소  →  넘침 없음         →  박스가 스크롤 컨테이너가 아님
                                     →  헤더 화면 고정 가능 + 좌우 이동 0
    ```
    즉 **"11열 전부" 와 "헤더 화면 고정" 은 동시에 불가능**하다.
    ★ 실측(한국 390px, 첫 열 150px):
    ```
    가로스크롤 100px → '카테고리' 100% 가림, '현재가' 62% 잘림
    가로스크롤 200px → '현재가'·'저점대비' 100% 가림
    ```
    → **최종 선택: 11열 유지 + 페이지 스크롤 + 가로 스크롤 + 고정 열 없음**
      (첫 열까지 모두 같은 속도로 스크롤 → 헤더 제목과 값이 항상 정렬된다).
    ★ **헤더 첫 셀만 풀면 더 나빠진다** — 실측(scrollLeft=150, 한국):
    ```
    x=60  헤더 '카테고리'  /  본문 '종목명'   ← 거짓 라벨
    x=120 헤더 '현재가'    /  본문 '종목명'   ← 거짓 라벨
    ```
    → 첫 열을 일부만 고정하는 건 불가능하다. 전부 고정하거나 전부 풀어야 한다.
    ★ 대가로 명확히 감수하는 것 2가지:
      ① 가로 스크롤하면 종목명이 화면 밖으로 나간다 (행 식별은 왼쪽으로 되돌려야)
      ② 아래로 내려가면 헤더 제목이 안 보인다 (헤더는 페이지와 함께 스크롤)
    ★ 되돌리려면: 헤더 화면 고정이 필요하면 폰에서 5열로 줄여야 한다
      (`table-layout:fixed` + % 폭으로 넘침 0 → 실측 320/360/390/430 전부 가능).
      그러면 `.table-card{overflow:visible}` + `.table-scroll{overflow:visible}` +
      `thead th{top:55px}` 로 헤더가 **페이지 기준**으로 붙는다(실측: 스크롤 1500 후
      정확히 55px). `.card{overflow:hidden}` 을 풀어야 한다는 점도 잊지 말 것.
    ★ 다른 탭 표는 고정 열을 유지한다 (대부분 가로 스크롤이 없어 무의미,
      검증 탭만 197px 스크롤 + 첫 열 63px).

16. **앱형(페이지 스크롤 0) 레이아웃은 표를 작게 만든다 — 되돌렸다.**
    `position:sticky` 로 표 카드를 붙이려면 **containing block 이 카드보다 높아야** 한다.
    카드가 자기 자식(표)만큼만 높으면 붙을 여지가 0 이라 동작하지 않는다
    (실측: 카드 top 626 → 스크롤 700 후 -18, 안 붙음).
    `body[data-tab=all]{height:100dvh;overflow:hidden;display:flex}` 로 페이지 스크롤을
    0 으로 만들면 표 박스가 남은 높이를 채워 붙긴 하는데,
    **실제 폰 뷰포트(390×664)에서는 표 박스가 167px = 4행** 밖에 안 된다.
    (상단바 55 + 히어로 41 + 상태바 34 + 탭 47 + 필터 225 + 카드 chrome 58 = 460)
    → "아래로 스크롤이 안 된다" 는 오해가 생기고, 표가 2축으로 떠다닌다.
    ★ **앱형은 되돌렸다.** 현재는 페이지가 스크롤되고 표는 페이지 흐름에 있다.

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

## 포트폴리오 저장

`localStorage` 키 **`etf-portfolio`** (테마 키 `etf-theme` 와 분리).

```jsonc
{ "version": 1, "holdings": { "us": { "SPY": { "addedAt": "2026-10-21" } } } }
```

- **보유 종목 코드만** 저장한다. 수량·매수가·거래이력은 저장하지 않는다.
  (익절 판정이 RSI·저점대비 % 기반이라 시세만으로 판단 가능)
- **시장별로 분리** 저장 — 미국/한국이 섞이면 안 된다.
- `loadPortfolio()` 는 `typeof localStorage` 가드 + `try/catch` + 스키마 검증.
  `couple-asset-manager` 의 `lib/storage.ts:22-46` 과 같은 패턴.
- 기기 간 동기화 없음 → `exportPortfolio()` / `importPortfolio()` 로 수동 백업.
- ★ 이 사이트는 서버가 없다. `data/etf_*.json` 이 서버 프록시 역할을 대체한다.
  (기존 `couple-asset-manager` 의 Yahoo API 프록시를 옮길 필요 없다)

## 종목명 필드 (3개로 분리)

| 필드 | 내용 | 용도 |
|---|---|---|
| `name` | 미국=영문 실명칭, 한국=한글 종목명 | **표시** (표·카드 제목 아님, 아래 참조) |
| `label` | 한국어 라벨 (universe.py 정의) | **정렬·검색·카드 제목** |
| `official_name` | 실명칭 (한국은=name) | title(호버)·카드 2번째 줄 |

★ 카드는 **항상 `label`(한국어) 을 제목**으로 쓰고, 영문 실명칭은
  `officialLine()` 이 2번째 줄에 붙인다. 카드의 `name` 은 표시용이고
  실제 카드 제목은 `label` 이다.
★ 정렬 키는 수치 필드만 쓰므로 `name` 이 바뀌어도 영향 없다.
★ 한국 ETF 의 야후 longName 은 'Mirae Asset Maps Management - ...' 처럼
  발행사 법인명까지 붙고 띄쓰기가 깨진다 → 한국은 한글 이름 유지.

## 테마 필터

- 옵션은 **현재 시장 데이터에서 동적 생성** (`fillThemeOptions`).
  하드코딩하면 시장 전환 시 어긋난다.
- 테마는 **카테고리와 독립**. 같은 테마가 여러 카테고리에 걸칠 수 있다
  (한국 '방산' 은 테마(449450) + 해외지수(494840)).
  카테고리 선택에 종속시키면 반대 카테고리의 해당 테마가 빠진다.
- **검색 vs 테마 필터는 하나만 적용** (B 방식). 둘 다 좁히면 0건.

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
