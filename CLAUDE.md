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
```

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
python scripts/backtest.py --refresh
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
