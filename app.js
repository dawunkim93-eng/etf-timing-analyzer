/* ETF 타이밍 분석 — 프런트엔드.
 * 외부 라이브러리 없음. 차트는 SVG 를 직접 그린다.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  market: 'us',
  data: null,
  portfolio: null,
  backtest: null,
  depth: null,
  fearGreed: null,
  exitRsi: 60,
  stopPct: 15,
  filters: { cat: '', sort: 'signal', state: '', depth: '', depthAll: '', search: '' },
};

/* 낙폭 버킷 라벨 — universe.py 의 DEPTH_BUCKETS 와 같은 순서 */
const DEPTH_ORDER = ['15% 미만', '15~20%', '20~25%', '25~30%', '30~35%', '35~40%', '40%+'];
const DEPTH_SWEET = '30~35%';
const DEPTH_CRASH = '40%+';

/* Fear & Greed 등급 → CSS 클래스 */
const FG_GRADE = {
  'extreme fear': 'ef',
  'fear': 'f',
  'neutral': 'n',
  'greed': 'g',
  'extreme greed': 'eg',
};
const fgGrade = (rating) => FG_GRADE[rating] || 'n';

/* 버킷 라벨 → CSS 클래스 (곡점 강조, 폭락 경고) */
function depthCls(label) {
  if (label === DEPTH_SWEET) return 'sweet';
  if (label === DEPTH_CRASH) return 'crash';
  return '';
}

const MARKETS = {
  us: { label: '🇺🇸 미국', file: 'data/etf_us.json', other: 'kr', otherLabel: '🇰🇷 한국' },
  kr: { label: '🇰🇷 한국', file: 'data/etf_kr.json', other: 'us', otherLabel: '🇺🇸 미국' },
};

/* ------------------------------------------------------------------ 포트폴리오
 * 보유 종목만 저장한다 (수량·매수가·거래이력은 저장하지 않음).
 * 익절 판정 기준이 RSI 와 '52주 저점 대비 %' 이고 둘 다 시세 데이터에서
 * 바로 나오므로 매수 정보 없이도 판단 가능하다.
 *
 * localStorage 는 브라우저·기기별이다. 기기 바꾸면 안 따라오고
 * 데이터를 지우면 사라진다 → JSON 내보내기/가져오기로 대응한다.
 */
const PF_KEY = 'etf-portfolio';
const PF_VERSION = 1;
const DEFAULT_PF = { version: PF_VERSION, holdings: {} };

function loadPortfolio() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PF, holdings: {} };
  try {
    const raw = localStorage.getItem(PF_KEY);
    if (!raw) return { ...DEFAULT_PF, holdings: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.holdings || typeof parsed.holdings !== 'object') {
      return { ...DEFAULT_PF, holdings: {} };
    }
    return { version: PF_VERSION, holdings: parsed.holdings };
  } catch {
    return { ...DEFAULT_PF, holdings: {} };
  }
}

function savePortfolio(pf) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PF_KEY, JSON.stringify(pf));
  } catch {
    /* 프라이빗 모드 등 — 조용히 무시 */
  }
}

function heldList(market) {
  const pf = state.portfolio;
  const bucket = pf && pf.holdings && pf.holdings[market];
  return bucket ? Object.keys(bucket) : [];
}

function isHeld(market, code) {
  return heldList(market).includes(code);
}

function toggleHold(market, code) {
  if (!state.portfolio) state.portfolio = { version: PF_VERSION, holdings: {} };
  if (!state.portfolio.holdings) state.portfolio.holdings = {};
  if (!state.portfolio.holdings[market]) state.portfolio.holdings[market] = {};
  const bucket = state.portfolio.holdings[market];
  if (bucket[code]) {
    delete bucket[code];
  } else {
    bucket[code] = { addedAt: new Date().toISOString().slice(0, 10) };
  }
  savePortfolio(state.portfolio);
  render();
}

/* JSON 백업 — localStorage 는 기기별로 분리되므로 수동 백업이 필요하다 */
function exportPortfolio() {
  if (!state.portfolio) return;
  const blob = new Blob([JSON.stringify(state.portfolio, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `etf-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importPortfolio(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.holdings || typeof parsed.holdings !== 'object') {
      return false;
    }
    state.portfolio = { version: PF_VERSION, holdings: parsed.holdings };
    savePortfolio(state.portfolio);
    render();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 유틸 */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const num = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('ko-KR', {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });

const pct = (v, d = 1) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`);

/* 검색어 정규화 — 대소문자 무시 + 공백 제거.
   "KODEX 200" → "kodex200" */
const normalizeQuery = (s) =>
  String(s || '').toLowerCase().replace(/\s+/g, '');

const fmtPrice = (v, cur) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v).toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return cur === 'KRW' ? `${n}원` : `$${n}`;
};

const cls = (v) => (v === null || v === undefined ? '' : v >= 0 ? 'pos' : 'neg');

/* 스파크라인 — 종가 배열을 SVG 경로로 */
function sparkline(values, w = 150, h = 34) {
  const vals = (values || []).filter((v) => v !== null && v !== undefined);
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = vals[vals.length - 1];
  const first = vals[0];
  const stroke = last >= first ? '#4c8f3a' : '#c4472e';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ------------------------------------------------------------------ 로드 */
/* 시장 세그먼트 상태 갱신 — 보고 있는 시장만 하이라이트한다. */
function updateMarketButtons() {
  document.querySelectorAll('[data-market]').forEach((b) => {
    const on = b.dataset.market === state.market;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}


async function loadMarket(market) {
  const cfg = MARKETS[market];
  $('data-status').textContent = '불러오는 중…';
  try {
    const res = await fetch(cfg.file, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('data-status').innerHTML = `<span class="stale">데이터를 못 불러왔습니다 (${esc(err.message)})</span>`;
    return;
  }
  state.market = market;
  updateMarketButtons();
  render();
}

async function loadBacktest() {
  try {
    const res = await fetch('data/backtest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    state.backtest = await res.json();
  } catch {
    state.backtest = null;
  }
  try {
    const res = await fetch('data/depth.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    state.depth = await res.json();
  } catch {
    state.depth = null;
  }
  try {
    const res = await fetch('data/feargreed.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    state.fearGreed = await res.json();
  } catch {
    state.fearGreed = null;
  }
  renderVerify();
  // 낙폭·공포지수 설명은 depth.json / feargreed.json 이 로드된 뒤에 채워진다
  if (state.data) {
    renderGuide();
    renderFearGreedSummary();
  }
}

/* ------------------------------------------------------------------ 렌더 */
function render() {
  const d = state.data;
  if (!d) return;
  const etfs = d.etfs || [];
  const regime = d.regime;

  // 헤더
  const bench = d.benchmark || {};
  $('hero-title').textContent =
    regime === 'bear' ? '지금은 약세 국면' : regime === 'bull' ? '지금은 상승 국면' : '국면 판단 불가';
  const hr = $('hero-regime');
  if (hr) {
    hr.textContent = `${regime === 'bear' ? '약세' : '상승'} 국면` +
      (bench.regime_since ? ` · ${bench.regime_since} 전환` : '');
  }
  const baseDate = etfs.find((e) => e.rsi_weekly_date)?.rsi_weekly_date || '';
  $('hero-desc').innerHTML =
    `52주 최저가 대비 <b>10% 이내</b> + 주봉 RSI <b>50 이하</b> 인 종목을 찾습니다. ` +
    `현재 ${etfs.filter((e) => e.signal.raw_pass).length}개가 원조건을 충족합니다.` +
    (baseDate ? ` <span style="opacity:.85">RSI 기준: ${esc(baseDate)} 주 확정</span>` : '');

  // 상태바
  const upd = d.updated_at_kst || '';
  const ageH = d.updated_at ? (Date.now() - Date.parse(d.updated_at)) / 3600000 : null;
  const stale = ageH !== null && ageH > 12;
  // 시장명을 항상 보여준다 — '지금은 약세 국면' 만으로는 한국인지 미국인지 구분 안 됨
  const mkLabel = state.market === 'kr' ? '한국' : '미국';
  const benchName = bench.name || '';
  $('data-status').innerHTML =
    `<span><b>${mkLabel}</b>${benchName ? ` · ${esc(benchName)}` : ''}</span>` +
    `<span>갱신 ${esc(upd)} KST</span>` +
    `<span class="${stale ? 'stale' : ''}">` +
    `${stale ? `오래됨 (${ageH.toFixed(0)}시간 전)` : '정상'} · ${etfs.length}종목</span>`;

  // 국면 카드 — 라벨만 두지 말고 근거를 함께 보여준다
  const rEl = $('regime-body');
  if (bench && bench.price !== undefined) {
    const since = bench.regime_since;
    const dd = bench.regime_dd;
    rEl.innerHTML = `
      <span class="regime-badge ${regime === 'bear' ? 'bear' : 'bull'}">${
        regime === 'bear' ? '약세 국면' : '상승 국면'
      }</span>
      <div class="regime-detail">
        ${esc(bench.name || bench.ticker)} ${fmtPrice(bench.price, d.currency_label)}
        ${since ? `· <b>${esc(since)}</b> 전환` : ''}
        ${dd !== null && dd !== undefined ? `· 고점 대비 <b class="${cls(dd)}">${pct(dd)}</b>` : ''}
        <br>
        52주 고점 대비 <b class="${cls(bench.from_high_pct)}">${pct(bench.from_high_pct)}</b> ·
        200일선 <b>${bench.ma200_above ? '위' : '아래'}</b> ·
        주봉 RSI <b>${num(bench.rsi, 1)}</b> ·
        1년 <b class="${cls(bench.ret_12m)}">${pct(bench.ret_12m)}</b>
        <br><span style="font-size:.72rem;opacity:.8">
        판정 기준: ${bench.regime_method === 'lt20'
          ? '직전 고점 대비 20% 하락 / 직전 저점 대비 20% 상승'
          : '1년 수익률 부호'} (${esc(bench.regime_index || '')} 지수 기준)
        </span>
      </div>`;
  } else {
    rEl.innerHTML = '<div class="empty">벤치마크를 못 불러와 국면을 판정하지 못했습니다.</div>';
  }

  renderMarketSummary();
  renderFearGreed();
  renderBenchmark();
  renderFearGreedSummary();
  renderBuy(etfs);
  renderHoldings();
  renderSell(etfs);
  renderAll(etfs);
  renderGuide();
}

/* ---------------- 시장 맥락 요약 (매수 탭 상단 배지) ---------------- */
function renderMarketSummary() {
  const d = state.data;
  if (!d) return;
  const b = d.benchmark || {};
  const isBear = d.regime === 'bear';
  const badge = $('ms-badge');
  const text = $('ms-text');
  if (!badge || !text) return;
  badge.textContent = isBear ? '약세 국면' : '상승 국면';
  badge.className = 'ms-badge ' + (isBear ? 'bear' : 'bull');
  const bits = [];
  bits.push(state.market === 'kr' ? '한국' : '미국');
  if (b.regime_since) bits.push(`${b.regime_since} 전환`);
  if (b.regime_dd !== null && b.regime_dd !== undefined) {
    bits.push(`고점 대비 ${pct(b.regime_dd)}`);
  }
  // 한국은 민간 계산 지수, 미국은 CNN 공식 지수
  const isKr = state.market === 'kr';
  const fg = isKr ? d.kr_fear_greed : d.fear_greed;
  if (fg) bits.push(`공포 ${num(fg.score, 0)}`);
  text.textContent = bits.length ? bits.join(' · ') : '시장 상황 보기';
}

/* ---------------- 벤치마크 지표 ---------------- */
function renderBenchmark() {
  const d = state.data;
  const el = $('bench-body');
  if (!d || !el) return;
  const b = d.benchmark || {};
  if (!b.price) {
    el.innerHTML = '<div class="empty">벤치마크를 불러오지 못했습니다.</div>';
    return;
  }
  // 벤치마크 ETF 항목을 찾아 저점대비·200일선 이격·낙폭 버킷을 얻는다
  const own = d.etfs.find((e) => e.code === b.ticker);

  const item = (label, value, cls) =>
    `<div class="bench-item">
      <div class="bench-k">${esc(label)}</div>
      <div class="bench-v ${cls || ''}">${value}</div>
    </div>`;

  const maDist = own ? own.ma200_dist_pct : null;
  el.innerHTML = `
    <div class="bench-grid">
      ${item('현재가', fmtPrice(b.price, d.currency_label))}
      ${item('1년 수익률', pct(b.ret_12m), cls(b.ret_12m))}
      ${item('52주 고점 대비', pct(b.from_high_pct), cls(b.from_high_pct))}
      ${item('52주 저점 대비', own ? pct(own.from_low_pct) : '—', own && own.from_low_pct <= 10 ? 'pos' : '')}
      ${item('200일선', b.ma200_above ? '위' : '아래', b.ma200_above ? 'pos' : 'neg')}
      ${item('200일선 이격', pct(maDist), cls(maDist))}
      ${item('주봉 RSI(14주)', num(b.rsi, 1), b.rsi <= 50 ? 'pos' : '')}
      ${item('낙폭 구간', own ? esc(own.signal.depth_label) : '—')}
    </div>
    <div class="fg-note">
      ${esc(b.name || b.ticker)} · 국면 판정 기준 지수 ${esc(b.regime_index || '')} (${b.regime_index_bars || 0}봉).
      주봉 RSI 기준일은 ${esc((d.etfs.find((e) => e.rsi_weekly_date) || {}).rsi_weekly_date || '—')} 주 확정.
    </div>`;
}

/* ---------------- 공포지수 요약 (시장 탭) ---------------- */
function renderFearGreedSummary() {
  const fg = state.fearGreed;
  const el = $('fg-summary');
  if (!el) return;
  const isKr = state.market === 'kr';
  const kr = state.fearGreed?.kr;

  if (isKr) {
    if (!kr) {
      el.innerHTML = '<div class="empty">한국 공포·탐욕 분석 결과가 없습니다.</div>';
      return;
    }
    const kSweet = (kr.buckets || []).find((b) => b.label === 'extreme fear');
    el.innerHTML = `
      <div class="guide">
        <p><b>공포가 극심할수록 매수 신호의 성과가 좋다.</b>
        한국 공포·탐욕이 극단적 공포였던 날은 평균 <b>${kSweet ? num(kSweet.avg_signals, 1) : '—'}개</b>의
        한국 ETF 가 매수 신호를 냈고, 이후 21거래일 KOSPI 수익률은
        평균 <b>${kSweet ? pct(kSweet.avg_21d_kospi_pct, 2) : '—'}</b>,
        승률 <b>${kSweet ? kSweet.win_pct : '—'}%</b>였다
        (n=${kSweet ? kSweet.n_days : '—'}, ${kr.source ? esc(kr.source) : '4.5년'}).</p>
        <p>한국 공포·탐욕 점수와 한국 ETF 매수 신호수의 상관계수는
        <b>${kr.corr !== null && kr.corr !== undefined ? kr.corr : '—'}</b>다.
        (점수가 낮을수록 — 즉 공포가 클수록 — 매수 신호가 많다.)</p>
        <div class="warnp">극단적 공포 구간 표본(${kSweet ? kSweet.n_days : '—'}일)은
        <b>2022년 하락장에 44%가 몰려 있다.</b> 이 구간의 수치는 2022년의 결과를
        크게 반영하므로 한 해의 Special situation 일 수 있다.</div>
        <p><button class="link-btn" data-goto="verify">검증 탭에서 자세히 ›</button></p>
      </div>`;
    return;
  }

  if (!fg) {
    el.innerHTML = '<div class="empty">공포지수 분석 결과가 없습니다.</div>';
    return;
  }
  const sweet = (fg.fg_buckets || []).find((b) => b.label === 'extreme fear');
  const vSweet = (fg.vix_buckets || []).find((b) => b.lo === 20);
  el.innerHTML = `
    <div class="guide">
      <p><b>공포가 극심할수록 매수 신호의 성과가 좋다.</b>
      CNN Fear & Greed 가 extreme fear 였던 날은 SPY 21거래일 후
      평균 <b>${sweet ? pct(sweet.avg_21d_pct, 2) : '—'}</b>,
      승률 <b>${sweet ? sweet.win_pct : '—'}%</b> 였다
      (n=${sweet ? sweet.n : '—'}, 최근 1년).</p>
      <p>10년 검증도 같은 방향이다. VIX 가 52주 고점 대비
      <b>20~30%</b> 구간(=극심한 공포)이었을 때 SPY 21거래일 수익률은
      <b>${vSweet ? pct(vSweet.avg_21d_pct, 2) : '—'}</b>,
      승률 <b>${vSweet ? vSweet.win_pct : '—'}%</b> (n=${vSweet ? vSweet.n : '—'}).</p>
      <p><button class="link-btn" data-goto="verify">검증 탭에서 자세히 ›</button></p>
    </div>`;
}


function renderFearGreed() {
  const d = state.data;
  const el = $('fg-body');
  if (!d || !el) return;
  // 한국은 민간 계산 지수, 미국은 CNN 공식 지수
  const isKr = state.market === 'kr';
  const fg = isKr ? d.kr_fear_greed : d.fear_greed;
  const vix = d.vix;
  const hist = isKr ? (d.kr_fg_history || []) : ((d.fear_greed && d.fear_greed.history) || []);

  if (!fg) {
    el.innerHTML = '<div class="empty">공포·탐욕 지수를 불러오지 못했습니다.</div>';
    return;
  }

  const g = fgGrade(fg.rating);
  const y = hist.map((h) => h.y);
  // 등급별 색으로 스파크라인 (점수 자체보다 등급 구간을 보여준다)
  const colorBy = (v) => {
    if (v < 25) return '#c0392b';
    if (v < 45) return '#e67e22';
    if (v < 55) return '#b8b8b2';
    if (v < 75) return '#2e8b57';
    return '#1e6b45';
  };
  let spark = '';
  if (y.length > 2) {
    const w = 340, h = 52, pad = 3;
    const min = 0, max = 100;
    const pts = y.map((v, i) => {
      const x = (i / (y.length - 1)) * (w - 2) + 1;
      const yy = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
      return `${x.toFixed(1)},${yy.toFixed(1)}`;
    });
    // 등급 경계선 (25/45/55/75)
    const band = (lo, hi, c) => {
      const yTop = h - pad - ((hi - min) / (max - min)) * (h - pad * 2);
      const yBot = h - pad - ((lo - min) / (max - min)) * (h - pad * 2);
      return `<rect x="0" y="${yTop.toFixed(1)}" width="${w}" height="${(yBot - yTop).toFixed(1)}" fill="${c}" opacity="0.10"/>`;
    };
    const last = y[y.length - 1];
    const lastX = w - 1;
    const lastY = h - pad - ((last - min) / (max - min)) * (h - pad * 2);
    spark = `<svg class="fg-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      ${band(0, 25, '#c0392b')}${band(25, 45, '#e67e22')}${band(45, 55, '#b8b8b2')}
      ${band(55, 75, '#2e8b57')}${band(75, 100, '#1e6b45')}
      <polyline points="${pts.join(' ')}" fill="none" stroke="${colorBy(last)}" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lastX}" cy="${lastY.toFixed(1)}" r="3" fill="${colorBy(last)}"/>
    </svg>`;
  }

  const prev = (label, v) => {
    if (v === null || v === undefined) return `<span>${label} —</span>`;
    // 이전 값이 현재보다 높으면 그 사이에 점수가 내려간 것 → ▼
    const diff = fg.score - v;
    const cls = diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : '';
    const arrow = diff > 0.05 ? '▲' : diff < -0.05 ? '▼' : '–';
    return `<span>${label} <b class="${cls}">${Number(v).toFixed(1)}</b> <span class="${cls}">${arrow}</span></span>`;
  };

  const comps = (fg.components || []).map((c) => {
    const cg = fgGrade(c.rating);
    return `<div class="fg-comp">
      <div class="fg-comp-t">
        <span class="fg-comp-n">${esc(c.label)}</span>
        <span class="fg-comp-v rg-${cg}">${num(c.score, 1)}</span>
      </div>
      <div class="fg-comp-bar"><div class="fg-comp-fill bg-${cg}" style="width:${Math.max(2, Math.min(100, c.score))}%"></div></div>
      <span class="fg-comp-r">${esc(c.rating_ko || c.rating)}</span>
    </div>`;
  }).join('');

  const vixLine = vix
    ? `<div class="fg-prev" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
        <span>VIX <b>${num(vix.current, 2)}</b></span>
        <span>52주 고점 대비 <b>${num(vix.ratio_52w, 1)}%</b></span>
        <span style="color:var(--ink3)">공포가 클수록 낮아집니다</span>
      </div>`
    : '';

  el.innerHTML = `
    <div class="fg-head">
      <div>
        <div class="fg-score rg-${g}">${num(fg.score, 1)}</div>
      </div>
      <div class="fg-label rg-${g}">${esc(fg.rating_ko || fg.rating)}
        <small>${isKr ? '민간 서비스 계산 지수 · Supabase 공개 버킷' : `CNN Fear & Greed · ${esc(fg.rating || '')}`}</small>
      </div>
    </div>
    <div class="fg-gauge"><div class="fg-marker" style="left:${Math.max(1, Math.min(99, fg.score))}%"></div></div>
    <div class="fg-scale"><span>극심한 공포 0</span><span>중립 50</span><span>극심한 탐욕 100</span></div>
    ${isKr ? '' : `<div class="fg-prev">
      ${prev('어제', fg.prev_close)}
      ${prev('1주 전', fg.prev_week)}
      ${prev('1개월 전', fg.prev_month)}
      ${prev('1년 전', fg.prev_year)}
    </div>`}
    ${spark}
    <div class="fg-comps">${comps}</div>
    ${vixLine}
    <div class="fg-note">
      최근 ${hist.length}일. 구성요소 ${(fg.components || []).length}개로 계산된다.
      <b>매수 신호 판정에는 쓰지 않는다</b> — 독립적인 참고 지표다.
      ${isKr ? '한국 지수는 공개 기관이 아니라 민간 서비스가 계산한다.' : ''}
    </div>`;
}

/* ---------------- 내 보유종목 · 익절 타이밍 ---------------- */
function renderHoldings() {
  const d = state.data;
  const listEl = $('hold-list');
  const sumEl = $('hold-summary');
  if (!d || !listEl) return;
  const market = state.market;
  const codes = heldList(market);
  const exitLine = state.exitRsi;
  const stop = state.stopPct === 'none' ? null : Number(state.stopPct);

  // 요약
  if (sumEl) {
    if (!codes.length) {
      sumEl.innerHTML = '';
    } else {
      const byMkt = Object.keys(state.portfolio.holdings || {}).filter(
        (m) => Object.keys(state.portfolio.holdings[m] || {}).length
      );
      const withSignal = codes.filter((c) => {
        const e = d.etfs.find((x) => x.code === c);
        return e && e.signal.raw_pass;
      }).length;
      sumEl.innerHTML = `<div class="hold-summary">
        <span>보유 <b>${codes.length}종목</b></span>
        <span class="mute">· ${byMkt.map((m) => (m === 'kr' ? '한국' : '미국') + ' ' + Object.keys(state.portfolio.holdings[m]).length).join(' · ')}</span>
        ${withSignal ? `<span class="pill p">지금 매수 신호 ${withSignal}개</span>` : ''}
      </div>`;
    }
  }

  if (!codes.length) {
    listEl.innerHTML = `<div class="empty">보유종목이 없습니다.<br>
      <b>전체 목록</b> 탭에서 각 행의 <b>+ 보유</b> 버튼으로 추가하세요.</div>`;
    return;
  }

  // 보유 종목별 카드
  const cards = codes.map((code) => {
    const e = d.etfs.find((x) => x.code === code);
    if (!e) {
      return `<div class="sig">
        <div class="sig-top">
          <span class="sig-code">${esc(code)}</span>
          <span class="sig-name">시세를 찾을 수 없는 종목</span>
        </div>
        <div class="sig-warn">이 종목의 시세 데이터가 없습니다. 유니버스에서 제외되었을 수 있습니다.
          아래 '제거' 로 정리하세요.</div>
        <div class="sig-foot">
          <button class="pf-remove" data-hold-code="${esc(code)}" data-hold-mkt="${esc(market)}">제거</button>
        </div>
      </div>`;
    }

    const rsi = e.rsi ?? 0;
    const lowPct = e.from_low_pct;
    const highPct = e.from_high_pct;
    // 게이지: RSI 30~80 구간을 0~100%로
    const pctPos = Math.max(0, Math.min(100, ((rsi - 30) / 50) * 100));
    const hot = rsi >= exitLine;
    const near = rsi >= exitLine - 10 && rsi < exitLine;
    const fillCls = hot ? 'hot' : near ? 'near' : '';
    const dist = exitLine - rsi;

    const status = hot
      ? '<span class="pill r">익절 도달</span>'
      : near
        ? '<span class="pill r">익절 임박</span>'
        : '<span class="pill n">보유</span>';

    // 저점 근접 유지 여부 (매수 조건: 저점+10% 이내)
    const nearLow = lowPct !== null && lowPct <= 10;
    const lowTag = nearLow
      ? '<span class="pill p">저점 근처 유지</span>'
      : lowPct !== null
        ? `<span class="pill n">저점 +${lowPct.toFixed(1)}%</span>`
        : '';

    let stopLine = '';
    if (stop !== null) {
      const stopPrice = e.price / (1 + stop / 100);
      const remain = ((e.price - stopPrice) / e.price) * 100;
      stopLine = `손절가 ${fmtPrice(stopPrice, d.currency_label)} (${remain.toFixed(1)}% 아래)`;
    } else {
      stopLine = '손절 없음';
    }

    return `<div class="sig">
      <div class="sig-top">
        <span class="sig-code">${esc(e.code)}</span>
        <span class="sig-name">${esc(e.name)}</span>
        ${status}
      </div>
      <div class="sig-tags" style="margin-top:6px">
        <span class="tag cat">${esc(e.category)}</span>
        <span class="tag theme">${esc(e.theme)}</span>
        ${lowTag}
      </div>
      <div class="sig-metrics" style="margin-top:9px">
        <div class="metric">
          <div class="k">현재가</div>
          <div class="v">${fmtPrice(e.price, d.currency_label)}</div>
        </div>
        <div class="metric">
          <div class="k">RSI(14주)</div>
          <div class="v ${hot ? 'warn' : near ? 'warn' : ''}">${num(rsi, 1)}</div>
        </div>
        <div class="metric">
          <div class="k">52주 저점 대비</div>
          <div class="v ${nearLow ? 'pass' : ''}">${pct(lowPct)}</div>
        </div>
      </div>
      <div class="gauge">
        <span class="gauge-label">RSI ${num(rsi, 1)} → ${exitLine}</span>
        <div class="gauge-bar"><div class="gauge-fill ${fillCls}" style="width:${pctPos.toFixed(1)}%"></div></div>
      </div>
      <div class="sig-extra">
        ${hot
          ? '익절 기준에 도달했습니다'
          : `익절까지 RSI ${dist.toFixed(1)}pt`}
        · 고점 대비 ${pct(highPct)}
        · ${esc(stopLine)}
      </div>
      <div class="sig-foot">
        <span class="sig-extra">${e.rsi_weekly_date ? esc(e.rsi_weekly_date) + ' 주 확정' : ''}</span>
        <button class="pf-remove" data-hold-code="${esc(e.code)}" data-hold-mkt="${esc(market)}">제거</button>
      </div>
    </div>`;
  });

  listEl.innerHTML = cards.join('');
}

/* ---------------- 매수 ---------------- */
function renderBuy(etfs) {
  const regime = state.data.regime;
  const depthFilter = state.filters.depth;
  const match = (e) => !depthFilter || e.signal?.depth_label === depthFilter;
  const regimeList = etfs.filter((e) => e.signal.regime_pass && match(e));
  const rawOnly = etfs.filter((e) => e.signal.raw_pass && !e.signal.regime_pass && match(e));

  $('regime-list').innerHTML = regimeList.length
    ? regimeList.map((e) => signalCard(e, true)).join('')
    : `<div class="empty">${
        regime === 'bear'
          ? '약세 국면이지만 두 조건을 동시에 만족하는 종목이 없습니다.'
          : `<b>지금은 상승 국면입니다.</b><br>
             이 규칙은 <b>약세 국면에서만</b> 검증되었습니다.<br>
             10년 백테스트에서 상승 국면에는 매수 신호가 거의 잡히지 않고,
             잡힌 것은 지수를 따라가지 못했습니다.<br>
             <span style="font-size:.76rem">매수 후보를 임의로 만들지 않습니다.
             아래 2순위는 참고용입니다.</span>`
      }</div>`;

  $('raw-list').innerHTML = rawOnly.length
    ? rawOnly.map((e) => signalCard(e, false)).join('')
    : '<div class="empty">원조건을 만족하는 종목이 없습니다.</div>';
}

function signalCard(e, isRegime) {
  const regime = state.data?.regime;
  const d = state.data;
  const lowOk = e.from_low_pct !== null && e.from_low_pct <= 10;
  const rsiOk = e.rsi !== null && e.rsi <= 50;
  const maDist = e.ma200_dist_pct;
  const depthLabel = e.signal?.depth_label || '';
  const level = e.history_level || 'standard';
  const weeks = e.history_weeks;
  const tags = [
    `<span class="tag cat">${esc(e.category)}</span>`,
    `<span class="tag theme">${esc(e.theme)}</span>`,
    depthLabel ? `<span class="tag depth ${depthCls(depthLabel)}">고점 대비 ${esc(depthLabel)}</span>` : '',
  ];
  if (level === 'new') {
    tags.push(`<span class="tag new">신규 · 이력 ${weeks}주</span>`);
  } else if (level === 'insufficient') {
    tags.push('<span class="tag observe">이력 부족</span>');
  }
  if (isRegime) tags.push('<span class="tag star">★ 약세 필터</span>');
  else tags.push(
    regime === 'bull'
      ? '<span class="tag warn">원조건만 · 참고용</span>'
      : '<span class="tag warn">원조건만</span>'
  );

  const unverified = e.signal?.verified === false;
  // 커버드콜은 옵션 기반 수익 전략 — 52주 저점 기준이 지수가 아니라 전략 NAV 저점
  const isCoveredCall = e.theme === '커버드콜';
  return `<div class="sig">
    <div class="sig-top">
      <span class="sig-code">${esc(e.code)}</span>
      <span class="sig-name">${esc(e.name)}</span>
    </div>
    <div class="sig-tags" style="margin-top:6px">${tags.join('')}</div>
    ${isCoveredCall ? '<div class="sig-warn">옵션 기반 수익 전략 — 52주 저점 기준이 지수가 아니라 이 ETF의 NAV 저점입니다. 상승 참여도가 낮습니다</div>' : ''}
    ${unverified ? '<div class="sig-warn">이력 52주 미만 — 저점 기준이 "가용 이력 전체"이며 백테스트로 검증되지 않았습니다</div>' : ''}
    <div class="sig-metrics four">
      <div class="metric">
        <div class="k">${e.is_full_52w ? '52주 저점 대비' : `저점 대비(${e.low_ref_weeks}주)`}</div>
        <div class="v ${lowOk ? 'pass' : 'fail'}">${pct(e.from_low_pct)}</div>
      </div>
      <div class="metric">
        <div class="k">RSI(14주)</div>
        <div class="v ${rsiOk ? 'pass' : 'fail'}">${num(e.rsi, 1)}</div>
        <div class="k sub">${esc(e.rsi_weekly_date || '')} 주 확정</div>
      </div>
      <div class="metric">
        <div class="k">고점 대비</div>
        <div class="v ${e.from_high_pct <= -30 ? 'pass' : ''}">${pct(e.from_high_pct)}</div>
      </div>
      <div class="metric">
        <div class="k">200일선 이격</div>
        <div class="v ${maDist === null ? '' : maDist >= 0 ? 'pass' : 'warn'}">${pct(maDist)}</div>
      </div>
    </div>
    <div class="sig-foot">
      ${sparkline(e.spark)}
      <span class="sig-extra">${fmtPrice(e.price, d.currency_label)}</span>
    </div>
  </div>`;
}

/* ---------------- 익절 ---------------- */
function renderSell(etfs) {
  const held = etfs.filter((e) => e.signal.raw_pass);
  const exitLine = state.exitRsi;
  const stop = state.stopPct === 'none' ? null : Number(state.stopPct);

  $('exit-note').textContent =
    `RSI ${exitLine} 를 넘으면 익절 신호. 백테스트에서 RSI>60 익절로 청산한 거래는 평균 +8.1%, 승률 83.6%(약세 국면 한정)이었습니다.`;

  if (!held.length) {
    $('sell-list').innerHTML =
      '<div class="empty">보유 중으로 볼 종목이 없습니다.<br>매수 타이밍 탭에서 신호가 뜬 종목을 사면 여기에 표시됩니다.</div>';
    return;
  }

  $('sell-list').innerHTML = held
    .map((e) => {
      const rsi = e.rsi ?? 0;
      // 게이지: RSI 30~80 구간을 0~100%로
      const pctPos = Math.max(0, Math.min(100, ((rsi - 30) / 50) * 100));
      const distToExit = exitLine - rsi;
      const near = rsi >= exitLine - 10 && rsi < exitLine;
      const hot = rsi >= exitLine;
      const fillCls = hot ? 'hot' : near ? 'near' : '';

      // 손절까지 남은 거리
      let stopLine = '';
      if (stop !== null) {
        const stopPrice = e.price / (1 + stop / 100);
        const remain = ((e.price - stopPrice) / e.price) * 100;
        stopLine = `손절가 ${fmtPrice(stopPrice, state.data.currency_label)} (${remain.toFixed(1)}% 아래)`;
      } else {
        stopLine = '손절 없음';
      }

      const status = hot ? '익절 기준 도달' : near ? '익절 임박' : '보유 유지';
      const statusPill = hot ? '<span class="pill r">익절 도달</span>'
        : near ? '<span class="pill r">익절 임박</span>'
        : '<span class="pill n">보유</span>';

      return `<div class="sig">
        <div class="sig-top">
          <span class="sig-code">${esc(e.code)}</span>
          <span class="sig-name">${esc(e.name)}</span>
          ${statusPill}
        </div>
        <div class="sig-metrics">
          <div class="metric">
            <div class="k">현재가</div>
            <div class="v">${fmtPrice(e.price, state.data.currency_label)}</div>
          </div>
          <div class="metric">
            <div class="k">RSI(14주)</div>
            <div class="v ${hot ? 'warn' : ''}">${num(e.rsi, 1)}</div>
            <div class="k sub">${esc(e.rsi_weekly_date || '')} 주 확정</div>
          </div>
          <div class="metric">
            <div class="k">고점 대비</div>
            <div class="v ${e.from_high_pct >= 0 ? 'pass' : 'warn'}">${pct(e.from_high_pct)}</div>
          </div>
        </div>
        <div class="gauge">
          <span class="gauge-label">RSI ${num(rsi, 1)} → ${exitLine}</span>
          <div class="gauge-bar"><div class="gauge-fill ${fillCls}" style="width:${pctPos.toFixed(1)}%"></div></div>
        </div>
        <div class="sig-extra" style="display:block;margin-top:6px">${esc(stopLine)}</div>
      </div>`;
    })
    .join('');
}

/* ---------------- 전체 목록 ---------------- */
function renderAll(etfs) {
  const catSel = $('f-cat');
  if (catSel.options.length <= 1) {
    const cats = [...new Set(etfs.map((e) => e.category))].sort();
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    }
  }
  // 카테고리 셀렉트 — 테마도 선택할 수 있게 한다
  const catSel2 = $('f-cat');
  if (catSel2 && catSel2.dataset.themed === '1') {
    catSel2.innerHTML = '<option value="">전체 카테고리</option>';
  }
  // 낙폭 버킷 셀렉트 — 시장이 바뀌면 개수가 달라지니 매번 다시 만든다
  for (const sel of [$('f-depth'), $('f-depth-all')]) {
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = sel.id === 'f-depth' ? '낙폭 전체 보기' : '낙폭 전체';
    sel.appendChild(first);
    for (const label of DEPTH_ORDER) {
      const count = etfs.filter((e) => e.signal?.depth_label === label).length;
      if (!count) continue;
      const o = document.createElement('option');
      o.value = label;
      o.textContent = `고점 대비 ${label} (${count})`;
      sel.appendChild(o);
    }
    // 시장 전환 전 선택을 되돌린다 (그 버킷이 없으면 해제)
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (prev) {
      state.filters.depth = '';
      state.filters.depthAll = '';
    }
  }

  const f = state.filters;
  const q = normalizeQuery(f.search);
  const hit = (e) =>
    !q ||
    normalizeQuery(e.code).includes(q) ||
    normalizeQuery(e.name).includes(q) ||
    normalizeQuery(e.theme).includes(q) ||
    normalizeQuery(e.category).includes(q);
  let rows = etfs.filter((e) => {
    if (!hit(e)) return false;
    if (f.cat && e.category !== f.cat) return false;
    if (f.state === 'regime' && !e.signal.regime_pass) return false;
    if (f.state === 'raw' && !e.signal.raw_pass) return false;
    if (f.state === 'none' && e.signal.raw_pass) return false;
    if (f.depthAll && e.signal?.depth_label !== f.depthAll) return false;
    return true;
  });

  const key = {
    signal: (e) => (e.signal.regime_pass ? 0 : e.signal.raw_pass ? 1 : 2) * 1000 + (e.from_low_pct ?? 999),
    low: (e) => e.from_low_pct ?? 999,
    rsi: (e) => e.rsi ?? 999,
    low52: (e) => -(e.from_low_pct ?? -999),
    ret12: (e) => -(e.ret_12m ?? -999),
    ma200: (e) => -(e.ma200_dist_pct ?? -999),
    depth: (e) => e.from_high_pct ?? 999,
    depth_shallow: (e) => -(e.from_high_pct ?? -999),
  }[f.sort];
  rows = rows.slice().sort((a, b) => key(a) - key(b));

  $('all-count').textContent = q
    ? `${rows.length} / ${etfs.length}종목`
    : `${rows.length}종목`;
  const empty = $('search-empty');
  if (empty) {
    empty.style.display = rows.length ? 'none' : '';
  }
  $('all-table').innerHTML = `
    <thead><tr>
      <th>종목</th><th>카테고리</th><th>현재가</th><th>저점대비</th><th>RSI(14주)</th>
      <th>고점대비</th><th>200일선</th><th>1년</th><th>이력</th><th>상태</th><th>보유</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (e) => `<tr>
      <td><span class="c">${esc(e.code)}</span> <span class="mute">${esc(e.name.slice(0, 14))}</span></td>
      <td class="mute">${esc(e.category)}</td>
      <td>${fmtPrice(e.price, state.data.currency_label)}</td>
      <td class="${e.from_low_pct <= 10 ? 'pos' : ''}">${pct(e.from_low_pct)}</td>
      <td class="${e.rsi <= 50 ? 'pos' : ''}" title="일봉 RSI ${num(e.rsi_daily, 1)} (참고)">${num(e.rsi, 1)}</td>
      <td class="${e.from_high_pct <= -30 ? 'pos' : ''}">${pct(e.from_high_pct)}</td>
      <td class="${cls(e.ma200_dist_pct)}">${pct(e.ma200_dist_pct)}</td>
      <td class="${cls(e.ret_12m)}">${pct(e.ret_12m)}</td>
      <td class="mute">${e.history_weeks}주</td>
      <td>${
        e.signal.regime_pass
          ? '<span class="pill p">★약세</span>'
          : e.signal.raw_pass
            ? '<span class="pill r">원조건</span>'
            : '<span class="pill n">—</span>'
      }</td>
      <td><button class="pf-add${isHeld(state.market, e.code) ? ' on' : ''}"
        data-hold-code="${esc(e.code)}" data-hold-mkt="${esc(state.market)}"
        aria-pressed="${isHeld(state.market, e.code)}">${
          isHeld(state.market, e.code) ? '✓ 보유' : '+ 보유'
        }</button></td>
    </tr>`
      )
      .join('')}</tbody>`;
}

/* ---------------- 검증 · 낙폭 ---------------- */
function renderDepth() {
  const d = state.depth;
  const sum = $('depth-summary');
  if (!d) {
    sum.innerHTML =
      '<div class="empty">낙폭 분석 결과가 없습니다. scripts/backtest.py 를 실행해 data/depth.json 을 생성하세요.</div>';
    return;
  }

  const uf = d.unfiltered;
  const best = d.buckets.find((b) => b.sweet_spot);

  sum.innerHTML = `
    <div class="guide">
      <p>기존 매수 신호(<code>저점+10% 이내 AND RSI ≤ ${d.rules.rsi_max}</code>) 안에서,
      52주 고점 대비 낙폭에 따라 <b>${d.hold_days}일 후</b> 성과가 어떻게 달라지는지 나눈 것입니다.</p>
      <p>전체 신호 <b>${uf.n.toLocaleString()}건</b>의 평균은 <b>${pct(uf.avg_pct, 2)}</b>,
      승률 ${uf.win_pct}%, 알파 ${pct(uf.alpha_pct, 2)} 입니다.
      낙폭이 깊어질수록 대체로 좋아지지만 <b>단조 증가가 아니라 봉우리</b>입니다.</p>
      ${
        best
          ? `<div class="warnp"><b>${best.label} 구간이 가장 좋았습니다</b> —
             평균 ${pct(best.avg_pct, 2)}, 승률 ${best.win_pct}%, 알파 ${pct(best.alpha_pct, 2)}.
             단, 표본이 <b>${best.n}행</b>뿐입니다. 연도별로는 크게 흔들리므로 아래 표를 반드시 보세요.</div>`
          : ''
      }
    </div>`;

  // 버킷별 상세
  $('depth-table').innerHTML = `
    <thead><tr><th>구간</th><th>n</th><th>평균</th><th>중앙</th><th>승률</th><th>알파</th>
    <th>전반</th><th>후반</th><th>종목집중</th></tr></thead>
    <tbody>${d.buckets
      .map((b) => {
        const cls = b.sweet_spot ? 'sweet' : b.label === DEPTH_CRASH ? 'crashrow' : '';
        const half = b.half || {};
        const conc = b.concentration || {};
        return `<tr class="${cls}">
        <td class="c">${esc(b.label)}</td>
        <td>${b.n.toLocaleString()}</td>
        <td class="${cls2(b.avg_pct)}">${pct(b.avg_pct, 2)}</td>
        <td class="${cls2(b.median_pct)}">${pct(b.median_pct, 2)}</td>
        <td>${b.win_pct}%</td>
        <td class="${cls2(b.alpha_pct)}">${pct(b.alpha_pct, 2)}</td>
        <td class="${cls2(half.early_alpha_pct)}">${pct(half.early_alpha_pct, 2)}</td>
        <td class="${cls2(half.late_alpha_pct)}">${pct(half.late_alpha_pct, 2)}</td>
        <td class="mute">${conc.unique_tickers}종목 / 상위5 ${conc.top5_share_pct}%</td>
      </tr>`;
      })
      .join('')}</tbody>`;

  // 연도별 매트릭스
  const years = [...new Set(d.buckets.flatMap((b) => b.yearly.map((y) => y.year)))].sort();
  $('depth-yearly').innerHTML = `
    <thead><tr><th>구간</th>${years.map((y) => `<th>${y.slice(2)}</th>`).join('')}</tr></thead>
    <tbody>${d.buckets
      .map((b) => {
        const byYear = Object.fromEntries(b.yearly.map((y) => [y.year, y]));
        return `<tr class="${b.sweet_spot ? 'sweet' : ''}">
        <td class="c">${esc(b.label)}</td>
        ${years
          .map((y) => {
            const rec = byYear[y];
            if (!rec) return '<td class="none">—</td>';
            const thin = rec.n < 30 ? ' thin' : '';
            return `<td class="${rec.alpha_pct >= 0 ? 'pos' : 'neg'}${thin}">${rec.alpha_pct > 0 ? '+' : ''}${rec.alpha_pct}</td>`;
          })
          .join('')}
      </tr>`;
      })
      .join('')}</tbody>`;

  $('depth-yearly-note').innerHTML =
    '알파(%). 연도별 표본이 30건 미만인 칸은 흐리게 표시했습니다. ' +
    `분할 기준 ${d.split_pivot} (전체 신호 구간의 캘린더 중위). ` +
    '<b>전반과 후반 알파의 부호가 다르면 표본 편향을 의심해야 합니다.</b> ' +
    '표본을 지우지 않고 전부 공개합니다.';

  // 상한선 필터
  $('depth-caps').innerHTML = `
    <thead><tr><th>낙폭 상한</th><th>n</th><th>평균</th><th>중앙</th><th>승률</th><th>알파</th></tr></thead>
    <tbody>
      <tr><td class="c">제한 없음</td><td>${uf.n.toLocaleString()}</td>
        <td class="${cls2(uf.avg_pct)}">${pct(uf.avg_pct, 2)}</td>
        <td class="${cls2(uf.median_pct)}">${pct(uf.median_pct, 2)}</td>
        <td>${uf.win_pct}%</td>
        <td class="${cls2(uf.alpha_pct)}">${pct(uf.alpha_pct, 2)}</td></tr>
      ${d.cap_filters
        .map(
          (c) => `<tr><td class="c">${c.cap}% 이내</td><td>${c.n.toLocaleString()}</td>
        <td class="${cls2(c.avg_pct)}">${pct(c.avg_pct, 2)}</td>
        <td class="${cls2(c.median_pct)}">${pct(c.median_pct, 2)}</td>
        <td>${c.win_pct}%</td>
        <td class="${cls2(c.alpha_pct)}">${pct(c.alpha_pct, 2)}</td></tr>`
        )
        .join('')}
    </tbody>`;

  // 순위축
  $('depth-rank').innerHTML = `
    <thead><tr><th>방식</th><th>n</th><th>평균</th><th>중앙</th><th>승률</th><th>알파</th></tr></thead>
    <tbody>${d.rank_axis
      .map(
        (r) => `<tr>
      <td class="c">낙폭순 상위 ${r.n_top}개</td><td>${r.depth_sorted.n.toLocaleString()}</td>
      <td class="${cls2(r.depth_sorted.avg_pct)}">${pct(r.depth_sorted.avg_pct, 2)}</td>
      <td class="${cls2(r.depth_sorted.median_pct)}">${pct(r.depth_sorted.median_pct, 2)}</td>
      <td>${r.depth_sorted.win_pct}%</td>
      <td class="${cls2(r.depth_sorted.alpha_pct)}">${pct(r.depth_sorted.alpha_pct, 2)}</td></tr>
      <tr><td class="c mute">└ 무작위 ${r.n_top}개 (대조군)</td><td>${r.random.n.toLocaleString()}</td>
      <td class="${cls2(r.random.avg_pct)}">${pct(r.random.avg_pct, 2)}</td>
      <td class="${cls2(r.random.median_pct)}">${pct(r.random.median_pct, 2)}</td>
      <td>${r.random.win_pct}%</td>
      <td class="${cls2(r.random.alpha_pct)}">${pct(r.random.alpha_pct, 2)}</td></tr>`
      )
      .join('')}</tbody>`;

  // 한계
  const notes = (d.caveats || []).map((c) => `<li>${esc(c)}</li>`).join('');
  $('depth-notes').innerHTML = `
    <div class="guide">
      <p>낙폭 축은 <b>매수 후보를 좁히는 데</b> 쓸 수 있습니다.
      하지만 순위 재배치에 쓰면 알파가 여전히 음수입니다 — 상승장을 따라가지 못하는
      근본 문제는 낙폭으로 고쳐지지 않습니다.</p>
      <ul>${notes}</ul>
      <div class="legend">
        <span><i class="lg-sweet"></i> 곡점 구간</span>
        <span><i class="lg-crash"></i> 폭락 구간 (밸류 트랩 위험)</span>
        <span><i class="lg-low"></i> 저수표 (n &lt; 500)</span>
      </div>
    </div>`;
}

function renderFearGreedVerify() {
  const fg = state.fearGreed;
  const body = $('fg-verify');
  const table = $('fg-table');
  if (!fg) {
    body.innerHTML = '<div class="empty">공포지수 분석 결과가 없습니다. scripts/backtest.py 를 실행해 data/feargreed.json 을 생성하세요.</div>';
    table.innerHTML = '';
    return;
  }
  const fgB = fg.fg_buckets || [];
  const vxB = fg.vix_buckets || [];
  const sweet = fgB.find((b) => b.label === 'extreme fear');
  const vSweet = vxB.find((b) => b.lo === 20);

  body.innerHTML = `
    <div class="guide">
      <p><b>공포가 극심할수록 매수 신호의 성과가 좋다.</b>
      CNN Fear & Greed 가 extreme fear 였던 날은 SPY 21거래일 후
      평균 <b>${sweet ? pct(sweet.avg_21d_pct, 2) : '—'}</b>,
      승률 <b>${sweet ? sweet.win_pct : '—'}%</b> 였다
      (n=${sweet ? sweet.n : '—'}, 최근 1년).</p>
      <p>10년 검증도 같은 방향이다. VIX 가 52주 고점 대비
      <b>20~30%</b> 구간(=극심한 공포)이었을 때 SPY 21거래일 수익률은
      <b>${vSweet ? pct(vSweet.avg_21d_pct, 2) : '—'}</b>,
      승률 <b>${vSweet ? vSweet.win_pct : '—'}%</b> (n=${vSweet ? vSweet.n : '—'}).</p>
      <div class="warnp"><b>단, 공포지수는 매수 신호 판정에 쓰지 않는다.</b>
      지금 규칙(저점+10% · RSI≤50 · 국면)과 독립적인 참고 지표다.
      또 CNN 은 <b>252일(1년)치만</b> 제공하므로 10년 검증은
      VIX 52주 고점 대비 비율로 재구성했다. VIX 비율은 '변동성의 위치',
      Fear &amp; Greed 는 '심리지수' 라서 <b>서로 사실상 무관</b>하다
      (상관계수 +0.01).</div>
    </div>`;

  const rows = [];
  for (const b of fgB) {
    const g = fgGrade(b.label);
    rows.push(`<tr>
      <td class="c rg-${g}">${esc(b.label)}</td>
      <td class="mute">${esc(b.rating_ko || '')}</td>
      <td>${b.n}</td>
      <td>${num(b.avg_signals, 1)}개</td>
      <td class="${cls2(b.avg_21d_pct)}">${pct(b.avg_21d_pct, 2)}</td>
      <td>${b.win_pct}%</td>
    </tr>`);
  }
  for (const b of vxB) {
    rows.push(`<tr style="border-top:2px solid var(--line)">
      <td class="c mute">VIX ${esc(b.label)}</td>
      <td class="mute">10년 검증</td>
      <td>${b.n}</td>
      <td class="mute">—</td>
      <td class="${cls2(b.avg_21d_pct)}">${pct(b.avg_21d_pct, 2)}</td>
      <td>${b.win_pct}%</td>
    </tr>`);
  }
  // 한국 공포·탐욕 구간 (민간 계산 지수 — 공식 지수가 아니다)
  const kr = state.fearGreed?.kr;
  if (kr && kr.buckets) {
    for (const b of kr.buckets) {
      const g = fgGrade(b.label);
      rows.push(`<tr style="border-top:2px solid var(--line)">
        <td class="c rg-${g}">한국 ${esc(b.label_ko || b.label)}</td>
        <td class="mute">${esc(kr.source || '')}</td>
        <td>${b.n_days}</td>
        <td>${num(b.avg_signals, 1)}개</td>
        <td class="${cls2(b.avg_21d_kospi_pct)}">${pct(b.avg_21d_kospi_pct, 2)}</td>
        <td>${b.win_pct}%</td>
      </tr>`);
    }
  }
  table.innerHTML = `
    <thead><tr><th>구간</th><th>근거</th><th>일수</th><th>평균신호수</th>
    <th>21일 후</th><th>승률</th></tr></thead>
    <tbody>${rows.join('')}</tbody>`;
  const krNote = state.fearGreed?.kr;
  if (krNote) {
    table.insertAdjacentHTML('afterend',
      `<div class="fg-note">한국 행은 21거래일 후 <b>KOSPI</b> 수익률, 위의 미국/VIX 행은 <b>SPY</b> 수익률이다.
       한국 지수는 <b>공식 지수가 아니라 민간 서비스가 계산한 값</b>이라 서비스마다 값이 다르다.</div>`);
  }
}

function cls2(v) {
  if (v === null || v === undefined) return '';
  return v >= 0 ? 'pos' : 'neg';
}

/* ---------------- 검증 ---------------- */
function renderVerify() {
  const bt = state.backtest;
  const sum = $('bt-summary');
  if (!bt) {
    sum.innerHTML =
      '<div class="empty">백테스트 결과가 없습니다. scripts/backtest.py 를 실행해 data/backtest.json 을 생성하세요.</div>';
    return;
  }

  const v = bt.variants;
  const plain = v.rsi60_plain;
  const bear = v.rsi60_plain_bear;
  const strictBear = v.rsi70_plain_bear;
  const ctrl = bt.random_control || {};

  sum.innerHTML = `
    <div class="guide">
      <p>미국 ETF <b>${bt.universe_size}종목</b>, ${bt.rules.bear_rule}, 2016-10 ~ 2026-10 (10년 일봉).
      매수 조건은 <code>52주 저점 +10% 이내 AND RSI ≤ ${bt.rules.rsi_max}</code> 입니다.</p>
      <div class="warnp">
        결론부터: 이 규칙은 <b>지수를 이기지 못했습니다</b>.
        무작위 진입보다 확실히 나쁘지는 않지만, SPY 를 사서 가만히 있는 것보다
        수익이 낮고 낙폭은 비슷했습니다. 강점은 <b>약세 국면에만 쓸 때</b> 드러납니다.
      </div>
      <h4>무작위 대조군 (같은 날짜 구간에서 랜덤 진입)</h4>
      <ul>
        <li>신호 진입: 평균 <b>+${plain.trade_stats.avg_pct}%</b>, 승률 ${plain.trade_stats.win_pct}%</li>
        <li>무작위 진입: 평균 <b>${ctrl.avg_pct}%</b>, 승률 ${ctrl.win_pct}%</li>
      </ul>
      <p class="em">규칙 자체는 작동합니다. 다만 그 효과는 "지수를 대체"하는 수준이 아니라
      "약세 국면에서 손실 폭을 줄이는" 수준입니다.</p>
    </div>`;

  const rows = [
    ['원조건만 · RSI&gt;60 익절', plain],
    ['원조건만 · RSI&gt;70 익절', v.rsi70_plain],
    ['약세 필터 · RSI&gt;60 익절', bear],
    ['약세 필터 · RSI&gt;70 익절', strictBear],
  ];
  $('bt-table').innerHTML = `
    <thead><tr><th>구성</th><th>거래</th><th>평균</th><th>승률</th><th>알파</th>
    <th>포트폴리오</th><th>연평균</th><th>MDD</th><th>SPY</th><th>투자비중</th></tr></thead>
    <tbody>${rows
      .map(([label, o]) => {
        const s = o.trade_stats;
        const p = o.portfolio;
        return `<tr>
        <td class="c">${label}</td>
        <td>${s.n}</td>
        <td class="${cls(s.avg_pct)}">${pct(s.avg_pct, 2)}</td>
        <td>${s.win_pct}%</td>
        <td class="${cls(s.alpha_avg_pct)}">${pct(s.alpha_avg_pct, 2)}</td>
        <td>${num(p.final, 2)}배</td>
        <td class="${cls(p.cagr_pct)}">${pct(p.cagr_pct, 2)}</td>
        <td class="neg">${pct(p.max_dd_pct, 1)}</td>
        <td class="mute">연${pct(p.bench_cagr_pct, 1)} / MDD${pct(p.bench_max_dd_pct, 1)}</td>
        <td class="mute">${p.invested_pct}%</td>
      </tr>`;
      })
      .join('')}</tbody>`;

  // ── 주봉 vs 일봉 비교 ──
  const dv = bt.daily_variants;
  if (dv) {
    $('tf-compare').innerHTML = `
      <div class="guide">
        <p>RSI 기준을 <b>일봉 → 주봉</b> 으로 바꿨을 때의 차이입니다.
        주봉은 "그 주가 끝나야" 확정되므로 <b>평일 중에는 값이 안 바뀝니다</b>.
        신호가 사라졌다가 다시 뜨는 일이 일봉보다 5배 적습니다.</p>
        <ul>
          <li>판정 안정성 — 일봉 10.95% → 주봉 <b>2.18%</b> (뒤집힘 비율)</li>
          <li>약세 국면 알파 — 일봉 ${pct(dv.rsi60_plain_bear.trade_stats.alpha_avg_pct, 2)} → 주봉 <b>${pct(bear.trade_stats.alpha_avg_pct, 2)}</b></li>
        </ul>
        <div class="warnp"><b>약세 필터 기준 연평균은 거의 같다</b>
        (${pct(dv.rsi60_plain_bear.portfolio.cagr_pct, 2)} → ${pct(bear.portfolio.cagr_pct, 2)}).
        대신 <b>알파가 확실히 낫다</b>
        (${pct(dv.rsi60_plain_bear.trade_stats.alpha_avg_pct, 2)} → ${pct(bear.trade_stats.alpha_avg_pct, 2)}).
        국면 필터 없이 쓰면 주봉이 손해다
        (연 ${pct(dv.rsi60_plain.portfolio.cagr_pct, 2)} → ${pct(plain.portfolio.cagr_pct, 2)}).
        주봉은 "느린" 탓이다 — 약세장 초반엔 아직 과열이라 신호가 안 나온다.</div>
      </div>`;

    const tfRows = [
      ['원조건만 · RSI&gt;60 익절', 'rsi60_plain', false],
      ['약세 필터 · RSI&gt;60 익절', 'rsi60_plain_bear', true],
      ['약세 필터 · RSI&gt;70 익절', 'rsi70_plain_bear', true],
    ];
    $('tf-table').innerHTML = `
      <thead><tr><th>구성</th><th>기준</th><th>거래</th><th>평균</th><th>승률</th><th>알파</th>
      <th>연평균</th><th>MDD</th><th>투자비중</th></tr></thead>
      <tbody>${tfRows
        .map(([label, key]) => {
          const w = bt.variants[key];
          const d = dv[key];
          const row = (o, tfName) => {
            const s = o.trade_stats, p = o.portfolio;
            return `<tr>
            <td class="c">${label}</td>
            <td class="mute">${tfName}</td>
            <td>${s.n}</td>
            <td class="${cls2(s.avg_pct)}">${pct(s.avg_pct, 2)}</td>
            <td>${s.win_pct}%</td>
            <td class="${cls2(s.alpha_avg_pct)}">${pct(s.alpha_avg_pct, 2)}</td>
            <td class="${cls2(p.cagr_pct)}">${pct(p.cagr_pct, 2)}</td>
            <td class="neg">${pct(p.max_dd_pct, 1)}</td>
            <td class="mute">${p.invested_pct}%</td>
          </tr>`;
          };
          return row(d, '일봉') + row(w, '주봉(현행)');
        })
        .join('')}</tbody>`;
  } else {
    $('tf-compare').innerHTML = '';
    $('tf-table').innerHTML = '';
  }

  // ── 국면 판정 방식 비교 ──
  const rv = bt.ret12_variants;
  if (rv) {
    $('rg-compare').innerHTML = `
      <div class="guide">
        <p>국면을 <b>1년 수익률 부호</b>로 판정하면 오류가 난다.
        한국 KODEX 200 이 1년 +81.8% 여서 "상승 국면" 으로 표시됐는데,
        실제로는 52주 고점 대비 -42.6%, 200일선 아래였다.
        1년 수익률은 <b>추세가 아니라 '과거 대비'</b> 다.</p>
        <p><b>Lunde-Timmermann 20% 규칙</b>은 직전 고점에서 20% 빠지면 하락장,
        직전 저점에서 20% 오르면 상승장으로 판정한다. 상태가 유지되므로
        10년 동안 국면 전환이 <b>22회 → 6회</b>로 줄었다.</p>
        <div class="warnp">단점도 있다. LT 규칙은 2022-2023 하락장을 243일짜리
        하나로 묶어, "지수가 아직 덜 빠진 때" 진입하는 비율이 낮아진다.
        그래서 <b>연평균과 알파는 1년 방식이 낫고, 승률·평균수익·최대낙폭은 LT 가 낫다.</b>
        어느 쪽도 지수를 이기지는 못한다.</div>
      </div>`;

    const rgRows = [
      ['원조건만 · RSI&gt;60 익절', 'rsi60_plain'],
      ['약세 필터 · RSI&gt;60 익절', 'rsi60_plain_bear'],
      ['약세 필터 · RSI&gt;70 익절', 'rsi70_plain_bear'],
    ];
    $('rg-table').innerHTML = `
      <thead><tr><th>구성</th><th>국면 기준</th><th>거래</th><th>평균</th><th>승률</th>
      <th>알파</th><th>연평균</th><th>MDD</th><th>투자비중</th></tr></thead>
      <tbody>${rgRows
        .map(([label, key]) => {
          const l = bt.variants[key];
          const r = rv[key];
          const row = (o, tfName) => {
            const s = o.trade_stats, p = o.portfolio;
            return `<tr>
            <td class="c">${label}</td>
            <td class="mute">${tfName}</td>
            <td>${s.n}</td>
            <td class="${cls2(s.avg_pct)}">${pct(s.avg_pct, 2)}</td>
            <td>${s.win_pct}%</td>
            <td class="${cls2(s.alpha_avg_pct)}">${pct(s.alpha_avg_pct, 2)}</td>
            <td class="${cls2(p.cagr_pct)}">${pct(p.cagr_pct, 2)}</td>
            <td class="neg">${pct(p.max_dd_pct, 1)}</td>
            <td class="mute">${p.invested_pct}%</td>
          </tr>`;
          };
          return row(r, '1년수익률') + row(l, 'LT 20% (현행)');
        })
        .join('')}</tbody>`;
  } else {
    $('rg-compare').innerHTML = '';
    $('rg-table').innerHTML = '';
  }

  // ── 공포지수 ↔ 매수 신호 관계 ──
  renderFearGreedVerify();

  const reasonRows = bear.trade_stats.reasons || {};
  $('bt-reasons').innerHTML = `
    <thead><tr><th>청산 사유</th><th>거래</th><th>평균</th><th>승률</th></tr></thead>
    <tbody>${Object.entries(reasonRows)
      .map(
        ([k, s]) =>
          `<tr><td class="c">${esc(k)}</td><td>${s.n}</td><td class="${cls(s.avg_pct)}">${pct(s.avg_pct, 2)}</td><td>${s.win_pct}%</td></tr>`
      )
      .join('')}</tbody>`;

  renderDepth();

  $('bt-notes').innerHTML = `
    <div class="guide">
      <h4>알파란 무엇인가</h4>
      <p>거래 수익률에서 <b>같은 기간 지수 수익률을 뺀 값</b>입니다.
      알파가 0 이라는 건 "지수보다 나았다"는 뜻이 아니라
      "지수를 못 이겼다"는 뜻입니다. 이 전략의 알파는 거의 0 입니다.</p>

      <h4>약세 필터의 대가</h4>
      <p>약세 국면에만 매수하면 투자 비중이 <b>${bear.portfolio.invested_pct}%</b> 로 떨어집니다.
      나머지 시간은 현금입니다. 그래서 연평균 수익은 지수에 못 미치지만
      최대 낙폭은 ${pct(bear.portfolio.max_dd_pct, 1)} 로 ${pct(bear.portfolio.bench_max_dd_pct, 1)} 보다
      ${Math.abs(bear.portfolio.bench_max_dd_pct - bear.portfolio.max_dd_pct).toFixed(1)}%p 나옵니다.</p>

      <h4>왜 이런 결과가 나오는가</h4>
      <ul>
        <li>52주 저점 근처 + RSI 50 이하라는 조건은 <b>약세장 끝부분</b>에 주로 성립합니다.
        그때 지수가 이미 많이 떨어졌으니, 지수보다 많이 오르기는 어렵습니다.</li>
        <li>반대로 지수가 오른 국면에서는 이 조건을 만족하는 종목이 거의 없습니다.
        그래서 그 구간의 상승을 따라가지를 못합니다.</li>
        <li>즉 이 규칙은 <b>상승을 따라가는 규칙이 아니라 낙폭을 줄이는 규칙</b>입니다.</li>
      </ul>

      <h4>이 백테스트가 못 하는 것</h4>
      <ul>
        <li><b>생존 편향</b> — 지금 살아있는 ETF 만으로 과거를 돌립니다.
        상장폐지된 3X·인버스 ETF 의 과거가 빠집니다.</li>
        <li><b>거래비용·세금</b> — 수수료와 배당세, 환율이 빠져 있습니다.
        특히 매번 거래하는 만큼 이 비용이 실제로는 큽니다.</li>
        <li><b>구간 겹침</b> — 3개월 구간이 주 단위로 겹쳐 통계적 유의성이 과장됩니다.</li>
        <li><b>앞으로의 미래</b> — 과거 규칙이 앞으로도 작동한다는 보장이 없습니다.</li>
      </ul>
    </div>`;
}

/* ---------------- 설명서 ---------------- */
function renderGuide() {
  const d = state.data;
  if (!d) return;
  const r = d.rules || {};

  $('g-buy').innerHTML = `
    <div class="guide">
      <h4>조건 1 — 52주 최저가 대비 ${r.low_from_52w}% 이내</h4>
      <p>현재가가 최근 252거래일의 <span class="em">최저가</span>에서
      ${r.low_from_52w}% 넘게 올랐지 않았다는 뜻입니다.popularity가 식은 지점입니다.</p>
      <h4>조건 2 — 주봉 RSI(14) ${r.rsi_max} 이하</h4>
      <p>과열되지 않았다는 뜻입니다. RSI 50 을 넘으면 이미 반등이 진행된 상태로 봅니다.</p>
      <p><b>주봉(14주 Wilder)</b> 을 씁니다. 일봉이 아니라.
      <b>주봉은 그 주가 끝나야 확정</b>되므로 평일 중에는 값이 안 바뀝니다 —
      금요일 종가 뒤 다음 주부터 새 값이 적용됩니다. 화면에는
      "기준일"로 표시합니다.</p>
      <p>주봉을 쓴 이유는 <b>안 흔들리기</b> 때문입니다. 'RSI 50 이하' 판정이
      일봉은 11일에 1번(10.95%) 뒤집히는데 주봉은 2.18% 다.
      하루 만에 신호가 사라졌다가 다시 뜨는 일이 줄어듭니다.</p>
      <p>대신 주봉은 <b>느립니다</b>. 약세장 초반에는 아직 과열이라 신호가 안 나오고
      바닥을 지나 반등이 확인된 뒤에야 잡힙니다. 그래서
      <b>포트폴리오 연평균이 떨어집니다</b> (약세 필터 기준
      ${state.backtest?.daily_variants?.rsi60_plain_bear?.portfolio?.cagr_pct ?? '—'}% →
      ${state.backtest?.variants?.rsi60_plain_bear?.portfolio?.cagr_pct ?? '—'}%).
      지수를 이기겠다는 게 아니라, <b>덜 흔들리고 손실은 더 작게</b> 만드는 선택입니다.</p>
      <h4>두 조건을 같이 쓰는 이유</h4>
      <p>저점 근접만 보면 <b>계속 떨어지는 중</b>인 종목도 잡힙니다. RSI 조건이 그걸 걸러냅니다.
      둘을 같이 쓰면 <span class="em">바닥을 확인한 반등 후보</span>만 남습니다.</p>
      <div class="warnp">조건 통과만으로 사라는 뜻은 아닙니다. 백테스트에서 이 조건은
      지수를 이기지 못했습니다. "사람들이 떠난 지점이 어디인가"를 찾는 도구로 쓰세요.</div>
      <h4>추적하는 ETF</h4>
      <p>현재 시장 <b>${d.etfs.length}</b>종목을 추적한다
      (미국 70 · 한국 50).
      섹터는 전부 덮고, 테마는 AUM 상위 600종목을 전수 조사해 빠진 테마를 메웠다
      (사이버보안·AI·원자력·로봇·인프라·전력인프라·우주·게임·배터리 등).</p>
      <p>레버리지·인버스 ETF 는 제외했다. 52주 저점 규칙이 의미가 없어진다
      (매일 2배로 움직여 52주 저점이 계속 갱신된다).</p>
    </div>`;

  $('g-sell').innerHTML = `
    <div class="guide">
      <h4>익절 — RSI 기준선 초과</h4>
      <p>보유 중 RSI 가 <span class="em">60</span> 또는 <span class="em">70</span> 을 넘으면
      과열로 판단해 익절 신호를 냅니다. 백테스트에서 RSI 익절로 청산한 거래는
      평균 수익이 가장 높고 승률도 높았습니다.</p>
      <h4>손절 — 진입가 대비 고정폭</h4>
      <p>기본 <span class="em">-15%</span>. 백테스트에서 -12% ~ -20% 구간은 결과 차이가
      크지 않았습니다. 손절이 없으면 익절을 기다리는 동안 손실이 커집니다.</p>
      <h4>보유 기간 상한</h4>
      <p>${d.rules?.max_hold ?? 63}거래일이 지나도 익절·손절이 없으면 정리합니다.
      백테스트에서 "만료"로 끝난 거래는 평균 수익이 음수였습니다.</p>
    </div>`;

  // 낙폭 설명
  const dep = state.depth;
  const sweet = dep?.buckets?.find((x) => x.sweet_spot);
  $('g-depth').innerHTML = `
    <div class="guide">
      <h4>52주 고점 대비 얼마나 떨어져 있는가</h4>
      <p>현재가가 최근 252거래일의 <span class="em">고점</span>에서 얼마나 내려와 있는지를
      낙폭이라고 합니다. 낙폭이 크면 "많이 빠졌다", 작으면 "거의 고점"이라는 뜻입니다.</p>
      <h4>왜 정보 축으로 쓰나</h4>
      <p>10년 백테스트에서 낙폭이 클수록 63일 후 성과가 대체로 좋았습니다.
      ${
        sweet
          ? `<br>특히 <span class="em">${esc(sweet.label)}</span> 구간이 가장 좋았지만
             (평균 ${pct(sweet.avg_pct, 2)}, 승률 ${sweet.win_pct}%, 알파 ${pct(sweet.alpha_pct, 2)}),
             표본이 ${sweet.n}행뿐이라 확정된 사실은 아닙니다.`
          : ''
      }</p>
      <h4>단조 증가가 아니다</h4>
      <p>40% 넘게 떨어진 구간은 오히려 성과가 나빠집니다. 구조적으로 망한 ETF 다수가
      거기 들어갑니다. <span class="em">많이 떨어졌다고 좋은 매수처는 아닙니다.</span></p>
      <h4>RSI 와 겹친다</h4>
      <p>낙폭만 조건을 걸어도 그 안의 RSI 중앙값이 59.8 에서 42.9 로 내려갑니다.
      즉 낙폭과 RSI 는 같은 방향을 보고 있고, <b>낙폭이 RSI 가 이미 잡은 것을 다시 잡는</b>
      성격입니다. 그래서 매수 조건에 추가하지 않고 정보로만 씁니다.</p>
      <h4>배지 색</h4>
      <ul>
        <li><span class="em">30~35%</span> — 곡점 구간 (초록)</li>
        <li><span class="em">40%+</span> — 폭락 구간 (주황, 밸류 트랩 주의)</li>
      </ul>
      <div class="warnp">매수 타이밍 탭의 "낙폭 필터"로 원하는 구간만 골라 볼 수 있습니다.
      다만 필터가 결과를 좋게 만드는 게 아니라, <b>높은 확신 구간만 골라 보는 도구</b>입니다.</div>
    </div>`;

  // 신규 상장 ETF 설명
  const std = d.etfs.filter((e) => e.history_level === 'standard').length;
  const newL = d.etfs.filter((e) => e.history_level === 'new').length;
  const ins = d.etfs.filter((e) => e.history_level === 'insufficient').length;
  $('g-new').innerHTML = `
    <div class="guide">
      <h4>이력에 따라 신호 등급이 달라진다</h4>
      <p>52주 저점 규칙은 <b>52주 이상 살아남은 ETF</b> 에서만 그대로 쓸 수 있다.
      상장한 지 얼마 안 된 ETF 는 52주 저점 자체가 없기 때문이다.
      그래서 이력을 세 단계로 나눈다.</p>
      <ul>
        <li><span class="em">표준</span> — 52주 이상. 52주 저점 규칙 그대로. 백테스트로 검증됨. (현재 ${std}종목)</li>
        <li><span class="em">신규</span> — 26~52주. 저점을 <b>가용 이력 전체</b> 로 계산한다.
        신호는 뜨지만 <b>백테스트로 검증되지 않았다</b> 고 화면에 표시한다. (현재 ${newL}종목)</li>
        <li><span class="em">관찰</span> — 26주 미만. <b>매수 신호로 승격하지 않는다.</b>
        지표만 보여준다. (현재 ${ins}종목)</li>
      </ul>
      <h4>왜 26주가 경계인가</h4>
      <p>가상 "상장 1년 ETF" 백테스트(과거 11개 시점, 미국 80종목)로 확인했다.
      상장을 1년 지났다고 가정하고 최근 1년치만 보고 신호를 낸 결과:</p>
      <ul>
        <li>상장 1년: 평균 <b>+9.80%</b>, 승률 <b>75.3%</b>, 알파 -0.01%</li>
        <li>상장 6주: 평균 <b>-3.37%</b>, 승률 <b>17.9%</b>, 알파 -3.85%</li>
      </ul>
      <p>즉 26주 이상이면 규칙이 그대로 작동하지만, 6개월 이내는 명백히 위험하다.
      주봉 RSI(14) 자체가 15주 최소 이력을 필요로 하므로 그 밑은 애초에 신뢰할 수 없다.</p>
      <div class="warnp">실전에서 신규 상장 ETF 가 화면에 떠는 일은 드물다.
      첫 상장 폭락 뒤 이미 저점에서 많이 회복돼 있어서, "저점 +10% 이내" 를
      만족하지 않는 경우가 많다. 신호가 뜨는 신규 ETF 는 예외적으로
      저점 근처에 있다는 뜻이다.</div>
    </div>`;

  // 공포지수 설명 (한국 탭은 한국 지수, 미국 탭은 CNN)
  const isKr = state.market === 'kr';
  const fgv = state.fearGreed;
  if (isKr) {
    const kr = state.fearGreed?.kr;
    const kSweet = kr?.buckets?.find((x) => x.label === 'extreme fear');
    $('g-fg').innerHTML = `
      <div class="guide">
        <h4>한국 공포 · 탐욕 지수</h4>
        <div class="warnp"><b>한국에는 "공식" 공포·탐욕 지수가 없다.</b>
        한국거래소(KRX)는 VKOSPI·KVIX 등 <b>변동성 지수만</b> 공표하고,
        공포·탐욕 지수는 전부 <b>민간 서비스가 각각 계산한 결과물</b>이다.
        그래서 서비스마다 값이 다르다 (2026-10-20 기준 Supabase 18 / feargree-api 27).
        이 사이트는 Supabase(현재값) + stockhub(30일 이력) 을 쓰며 둘은 같은 백엔드다.</div>
        <h4>공포가 극심할수록 매수 신호 성과가 좋다</h4>
        <ul>
          <li>극단적 공포였던 날: 한국 ETF 평균 <b>${kSweet ? num(kSweet.avg_signals, 1) : '—'}개</b>가
          매수 신호, 이후 21거래일 KOSPI 평균
          <b>${kSweet ? pct(kSweet.avg_21d_kospi_pct, 2) : '—'}</b>,
          승률 <b>${kSweet ? kSweet.win_pct : '—'}%</b> (n=${kSweet ? kSweet.n_days : '—'}, 4.5년)</li>
          <li>한국 공포·탐욕 점수 ↔ 한국 ETF 매수 신호수 상관계수
          <b>${kr?.corr !== null && kr?.corr !== undefined ? kr.corr : '—'}</b></li>
        </ul>
        <div class="warnp"><b>매수 신호 판정에는 쓰지 않는다.</b> 지금 규칙과 독립적인
        참고 지표로만 쓴다. 또 stockhub 이력은 <b>평일만 갱신</b>해서 주말 구간이
        평평하게 보인다 — 실제 변동이 아니다.</div>
      </div>`;
  } else {
    const fgSweet = fgv?.fg_buckets?.find((x) => x.label === 'extreme fear');
    const vSweet = fgv?.vix_buckets?.find((x) => x.lo === 20);
    $('g-fg').innerHTML = `
      <div class="guide">
        <h4>CNN Fear & Greed Index (미국 기준)</h4>
        <p>0~100 점수와 5개 등급(극심한 공포 · 공포 · 중립 · 탐욕 · 극심한 탐욕)이다.
        8개 구성요소(S&P500 모멘텀 · 주가 강도 · 시장 폭 · 풋/콜 비율 · VIX 변동성 ·
        저등급채 수요 · 안전자산 수요)를 합산해 만든다.
        카드는 <b>시장 탭</b>에 있다.</p>
        <h4>공포가 극심할수록 매수 신호 성과가 좋다</h4>
        <ul>
          <li>Fear &amp; Greed 가 extreme fear 였던 날: SPY 21거래일 후
          평균 <b>${fgSweet ? pct(fgSweet.avg_21d_pct, 2) : '—'}</b>,
          승률 <b>${fgSweet ? fgSweet.win_pct : '—'}%</b> (n=${fgSweet ? fgSweet.n : '—'}, 최근 1년)</li>
          <li>10년 검증 (VIX 52주 고점 대비 20~30% 구간):
          평균 <b>${vSweet ? pct(vSweet.avg_21d_pct, 2) : '—'}</b>,
          승률 <b>${vSweet ? vSweet.win_pct : '—'}%</b> (n=${vSweet ? vSweet.n : '—'})</li>
        </ul>
        <div class="warnp"><b>단, 매수 신호 판정에는 쓰지 않는다.</b>
        지금 규칙(저점+10% · RSI≤50 · 국면)과 독립적인 참고 지표로만 쓴다.
        또 CNN 은 <b>252일(1년)치만</b> 제공하므로 10년 검증은 VIX 로 재구성했다.
        VIX 비율('변동성의 위치')과 Fear &amp; Greed 점수('심리지수')는
        <b>사실상 무관</b>하다(상관계수 +0.01). 같은 숫자를 다른 각도로 보는 게 아니다.</div>
      </div>`;
  }

  const b = d.benchmark || {};
  const rg = state.backtest?.variants?.rsi60_plain_bear;
  const rg12 = state.backtest?.ret12_variants?.rsi60_plain_bear;
  $('g-regime').innerHTML = `
    <div class="guide">
      <h4>판정 기준 — Lunde-Timmermann 20% 규칙</h4>
      <p>지수(${esc(b.regime_index || b.name || '지수')})가
      <span class="em">직전 고점에서 20% 빠지면 하락장</span>,
      <span class="em">직전 저점에서 20% 오르면 상승장</span>입니다.
      상태가 유지되므로 "한 달짜리 지수"가 아니라 <b>추세</b>를 읽습니다.</p>
      <h4>왜 1년 수익률로 판정하지 않나</h4>
      <p>1년 수익률은 <b>추세가 아니라 '과거 대비'</b>입니다.
      한국 KODEX 200이 1년 +81.8%여서 "상승 국면"으로 표시됐던 적이 있는데,
      실제로는 52주 고점 대비 -42.6%, 200일선 아래였습니다.</p>
      <p>10년 동안 1년 방식은 국면을 <b>22번</b> 뒤집었고, LT 규칙은 <b>6번</b>입니다.
      1년 방식은 매달 국면이 반전돼 "약세 국면" 표시가 신뢰를 못 줍니다.</p>
      <h4>백테스트 결과 (10년, 미국 ETF 40종목)</h4>
      <ul>
        <li>약세 필터 시 평균수익 <b>${rg ? pct(rg.trade_stats.avg_pct, 2) : '—'}</b>,
        승률 <b>${rg ? rg.trade_stats.win_pct : '—'}%</b>,
        최대낙폭 <b>${rg ? pct(rg.portfolio.max_dd_pct, 1) : '—'}</b></li>
        <li>1년 방식 대비 연평균은 <b>${rg12 ? pct(rg12.portfolio.cagr_pct, 2) : '—'} →
        ${rg ? pct(rg.portfolio.cagr_pct, 2) : '—'}</b> 로 낮고,
        알파도 <b>${rg12 ? pct(rg12.trade_stats.alpha_avg_pct, 2) : '—'} →
        ${rg ? pct(rg.trade_stats.alpha_avg_pct, 2) : '—'}</b> 다</li>
      </ul>
      <div class="warnp">LT 규칙은 2022-2023 하락장을 243일짜리 하나로 묶기 때문에
      "지수가 아직 덜 빠진 때" 진입하는 비율이 낮아진다. 그래서 연평균과 알파는
      1년 방식이 낫고, <b>승률·평균수익·최대낙폭은 LT 가 낫다.</b>
      어느 쪽도 지수를 이기지는 못한다. 검증 탭에 두 방식의 자리를 다 비교해 둔다.</div>
      <div class="warnp">또 하나 — <b>이 규칙은 약세 국면에서만 검증되었다.</b>
      상승 국면에는 매수 신호가 거의 잡히지 않고, 잡힌 것은 지수를 따라가지 못했다.
      그래서 상승 국면에서 1순위 신호가 0개여도 <b>매수 후보를 임의로 만들지 않는다.</b></div>
    </div>`;

  $('g-calc').innerHTML = `
    <div class="guide">
      <h4>52주 저·고점</h4>
      <p>최근 <span class="em">252거래일의 일봉 저가/고가</span> 를 씁니다.
      종가가 아니라 <b>장중 저가</b> 기준이라 실제 브로커 화면의 52주 최고·최저와
      대체로 일치합니다. 야후 메타의 52주 필드는 <b>한국 ETF 에서 0 을 반환</b>해서
      전부 직접 계산합니다.</p>
      <h4>RSI (주봉)</h4>
      <p>Wilder 평활, 기간 <b>14주</b>, 주봉 종가 기준.
      일봉을 ISO 주(월~금)로 묶고 각 주 마지막 거래일 종가를 쓴다.</p>
      <p><b>무목적 처리</b> — 주봉은 그 주가 끝나야 확정된다. 그래서
      어떤 날짜 시점에서든 <b>이미 지나간 주</b>의 값만 쓴다.
      진행중 주의 RSI 를 쓰면 아직 오지 않은 날짜의 데이터가 섞여 미래정보가 된다.</p>
      <p><b>시간프레임 혼합 금지</b> — RSI 만 주봉이고 52주 저·고점 / MA50 / MA200 /
      수익률 / 낙폭은 <b>일봉 그대로</b>다. 이건 의도된 설계다.</p>
      <h4>현재가</h4>
      <p>야후 일봉 배열의 마지막 봉은 실제 마지막 거래일보다 하루씩 밀려 있다
      (meta 는 오늘 거래분을 가지고 있는데 배열은 그 전까지다). 그래서 배열 끝에
      meta 의 오늘 거래분을 <b>덧붙여</b> 모든 지표가 같은 기준일까지 계산되게 한다.
      붙이지 않으면 현재가가 52주 저점 계산에서 빠지고 주봉 RSI 도 한 주 밀린다.</p>
      <h4>이동평균</h4>
      <p>50일·200일 단순 이동평균, 종가 기준. 200일선 이격은
      <code>(현재가 ÷ 200일선 − 1) × 100</code> 입니다.</p>
      <h4>수익률</h4>
      <p>1M=21거래일, 3M=63, 6M=126, 12M=252. <b>달력일이 아니라 거래일</b>입니다.</p>
      <h4>수집 주기</h4>
      <p>미국 장중 30분, 한국 장중 30분, 장외 2시간 간격. 지수는 주말에도 마지막
      거래일 값을 그대로 씁니다.</p>
    </div>`;

  $('g-limits').innerHTML = `
    <div class="guide">
      <ul>
        <li><b>지수를 이기지 못합니다.</b> 백테스트 알파는 거의 0 입니다.</li>
        <li><b>약세 국면에만 강합니다.</b> 상승장에서 이 규칙은 자리가 없습니다.</li>
        <li><b>생존 편향</b> — 상장폐지 ETF 가 빠져 있습니다.</li>
        <li><b>거래비용·세금 미반영</b> — 실제로는 더 불리합니다.</li>
        <li><b>ETF 는 지수에 1:1로 안 따라갑니다.</b> 추적오차·수수료·이자비용이 있습니다.</li>
        <li><b>레버리지·인버스 ETF 는 제외</b>했습니다. 52주 저점 규칙이 의미가 없어집니다.</li>
        <li><b>한국 ETF 는 원화 기준</b>이라 환율이 빠져 있습니다. KODEX 200 은 지수와 거의 같지만
        다른 종목은 차이가 있습니다.</li>
        <li><b>낙폭 축도 표본 편향이 있습니다.</b> 표본 821행짜리 구간의 연도별 성과가
        2018 +6.6 → 2021 -18.9 → 2024 -5.7 로 흔들립니다.</li>
        <li><b>낙폭은 RSI 와 독립 정보가 아닙니다.</b> 낙폭이 크면 RSI 도 자동으로 낮아집니다.</li>
        <li><b>_site 는 보유 여부를 모릅니다.</b> "보유 중"은 매수 신호가 난 종목을 가리키는 표시입니다.</li>
      </ul>
    </div>`;
}

/* ------------------------------------------------------------------ 이벤트 */
function switchTab(tab) {
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === `tab-${tab}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );

  // 매수 탭 상단 시장 요약 배지 → 시장 탭 이동
  $('ms-btn').addEventListener('click', () => switchTab('market'));

  // [검증 탭에서 자세히] 링크
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) switchTab(b.dataset.goto);
  });

  document.querySelectorAll('[data-market]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.market !== state.market) loadMarket(b.dataset.market);
    })
  );

  $('theme-btn').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('etf-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  });
  if (localStorage.getItem('etf-theme') === 'dark') document.body.classList.add('dark');

  // 검색 — 한글 IME 조합 중에는 필터링하지 않는다.
  // 조합 중에는 이벤트가 여러 번 오고 중간 문자열로 필터하면 지저분해진다.
  let composing = false;
  const searchEl = $('f-search');
  if (searchEl) {
    searchEl.addEventListener('compositionstart', () => { composing = true; });
    searchEl.addEventListener('compositionend', (e) => {
      composing = false;
      state.filters.search = e.target.value;
      renderAll(state.data.etfs);
    });
    searchEl.addEventListener('input', (e) => {
      if (composing) return;
      state.filters.search = e.target.value;
      renderAll(state.data.etfs);
    });
  }
  const searchReset = $('search-reset');
  if (searchReset) {
    searchReset.addEventListener('click', () => {
      state.filters = { ...state.filters, cat: '', sort: 'signal', state: '', depth: '', depthAll: '', search: '' };
      if (searchEl) searchEl.value = '';
      renderAll(state.data.etfs);
    });
  }

  // 보유 추가/제거 — 목록 행의 + 보유, 익절 탭 카드의 제거
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-hold-code]');
    if (!btn) return;
    e.preventDefault();
    toggleHold(btn.dataset.holdMkt, btn.dataset.holdCode);
  });

  // 포트폴리오 백업
  const pfExport = $('pf-export');
  if (pfExport) pfExport.addEventListener('click', exportPortfolio);
  const pfImport = $('pf-import');
  const pfFile = $('pf-file');
  if (pfImport && pfFile) {
    pfImport.addEventListener('click', () => pfFile.click());
    pfFile.addEventListener('change', () => {
      const file = pfFile.files && pfFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const ok = importPortfolio(String(reader.result || ''));
        alert(ok ? '포트폴리오를 불러왔습니다.' : '형식이 올바르지 않습니다.');
        pfFile.value = '';
      };
      reader.readAsText(file);
    });
  }

  $('f-cat').addEventListener('change', (e) => {
    state.filters.cat = e.target.value;
    renderAll(state.data.etfs);
  });
  $('f-sort').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    renderAll(state.data.etfs);
  });
  $('f-state').addEventListener('change', (e) => {
    state.filters.state = e.target.value;
    renderAll(state.data.etfs);
  });
  $('f-depth').addEventListener('change', (e) => {
    state.filters.depth = e.target.value;
    renderBuy(state.data.etfs);
  });
  $('f-depth-all').addEventListener('change', (e) => {
    state.filters.depthAll = e.target.value;
    renderAll(state.data.etfs);
  });

  $('exit-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('exit-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.exitRsi = Number(b.dataset.exit);
    renderSell(state.data.etfs);
  });

  $('stop-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('stop-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.stopPct = b.dataset.stop;
    renderSell(state.data.etfs);
  });

  state.portfolio = loadPortfolio();
  loadBacktest();
  loadMarket('us');
});
