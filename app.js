/* ETF 타이밍 분석 — 프런트엔드.
 * 외부 라이브러리 없음. 차트는 SVG 를 직접 그린다.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  market: 'us',
  data: null,
  backtest: null,
  exitRsi: 60,
  stopPct: 15,
  filters: { cat: '', sort: 'signal', state: '' },
};

const MARKETS = {
  us: { label: '🇺🇸 미국', file: 'data/etf_us.json', other: 'kr', otherLabel: '🇰🇷 한국' },
  kr: { label: '🇰🇷 한국', file: 'data/etf_kr.json', other: 'us', otherLabel: '🇺🇸 미국' },
};

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
  $('mkt-btn').textContent = `${cfg.label} → ${cfg.otherLabel}`;
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
  renderVerify();
}

/* ------------------------------------------------------------------ 렌더 */
function render() {
  const d = state.data;
  if (!d) return;
  const etfs = d.etfs || [];
  const regime = d.regime;

  // 헤더
  $('hero-title').textContent =
    regime === 'bear' ? '지금은 약세 국면' : regime === 'bull' ? '지금은 상승 국면' : '국면 판단 불가';
  const bench = d.benchmark || {};
  $('hero-desc').innerHTML =
    `52주 최저가 대비 <b>10% 이내</b> + RSI <b>50 이하</b> 인 종목을 찾습니다. ` +
    `현재 ${etfs.filter((e) => e.signal.raw_pass).length}개가 원조건을 충족합니다.`;
  document.querySelector('.hero .regime-line')?.remove();

  // 상태바
  const upd = d.updated_at_kst || '';
  const ageH = d.updated_at ? (Date.now() - Date.parse(d.updated_at)) / 3600000 : null;
  const stale = ageH !== null && ageH > 12;
  $('data-status').innerHTML =
    `<span>갱신 ${esc(upd)} KST</span><span class="${stale ? 'stale' : ''}">` +
    `${stale ? `오래됨 (${ageH.toFixed(0)}시간 전)` : '정상'} · ${etfs.length}종목</span>`;

  // 국면 카드
  const rEl = $('regime-body');
  if (bench && bench.price !== undefined) {
    rEl.innerHTML = `
      <span class="regime-badge ${regime === 'bear' ? 'bear' : 'bull'}">${
        regime === 'bear' ? '약세 국면' : '상승 국면'
      }</span>
      <div class="regime-detail">
        ${esc(bench.name || bench.ticker)} ${fmtPrice(bench.price, d.currency_label)} ·
        1년 <b class="${cls(bench.ret_12m)}">${pct(bench.ret_12m)}</b> ·
        200일선 <b>${bench.ma200_above ? '위' : '아래'}</b> ·
        RSI ${num(bench.rsi, 1)}
        <br>약세 판정 기준: 벤치마크 1년 수익률 0% 미만
      </div>`;
  } else {
    rEl.innerHTML = '<div class="empty">벤치마크를 못 불러와 국면을 판정하지 못했습니다.</div>';
  }

  renderBuy(etfs);
  renderSell(etfs);
  renderAll(etfs);
  renderGuide();
}

/* ---------------- 매수 ---------------- */
function renderBuy(etfs) {
  const regime = state.data.regime;
  const regimeList = etfs.filter((e) => e.signal.regime_pass);
  const rawOnly = etfs.filter((e) => e.signal.raw_pass && !e.signal.regime_pass);

  $('regime-list').innerHTML = regimeList.length
    ? regimeList.map((e) => signalCard(e, true)).join('')
    : `<div class="empty">${
        regime === 'bear'
          ? '약세 국면이지만 두 조건을 동시에 만족하는 종목이 없습니다.'
          : '지금은 상승 국면이라 약세 필터 신호가 없습니다.<br>아래 2순위(원조건)를 참고하세요.'
      }</div>`;

  $('raw-list').innerHTML = rawOnly.length
    ? rawOnly.map((e) => signalCard(e, false)).join('')
    : '<div class="empty">원조건을 만족하는 종목이 없습니다.</div>';
}

function signalCard(e, isRegime) {
  const d = state.data;
  const lowOk = e.from_low_pct !== null && e.from_low_pct <= 10;
  const rsiOk = e.rsi !== null && e.rsi <= 50;
  const maDist = e.ma200_dist_pct;
  const tags = [
    `<span class="tag cat">${esc(e.category)}</span>`,
    `<span class="tag theme">${esc(e.theme)}</span>`,
  ];
  if (isRegime) tags.push('<span class="tag star">★ 약세 필터</span>');
  else tags.push('<span class="tag warn">원조건만</span>');

  return `<div class="sig">
    <div class="sig-top">
      <span class="sig-code">${esc(e.code)}</span>
      <span class="sig-name">${esc(e.name)}</span>
    </div>
    <div class="sig-tags" style="margin-top:6px">${tags.join('')}</div>
    <div class="sig-metrics">
      <div class="metric">
        <div class="k">52주 저점 대비</div>
        <div class="v ${lowOk ? 'pass' : 'fail'}">${pct(e.from_low_pct)}</div>
      </div>
      <div class="metric">
        <div class="k">RSI(14)</div>
        <div class="v ${rsiOk ? 'pass' : 'fail'}">${num(e.rsi, 1)}</div>
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
            <div class="k">RSI(14)</div>
            <div class="v ${hot ? 'warn' : ''}">${num(e.rsi, 1)}</div>
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

  const f = state.filters;
  let rows = etfs.filter((e) => {
    if (f.cat && e.category !== f.cat) return false;
    if (f.state === 'regime' && !e.signal.regime_pass) return false;
    if (f.state === 'raw' && !e.signal.raw_pass) return false;
    if (f.state === 'none' && e.signal.raw_pass) return false;
    return true;
  });

  const key = {
    signal: (e) => (e.signal.regime_pass ? 0 : e.signal.raw_pass ? 1 : 2) * 1000 + (e.from_low_pct ?? 999),
    low: (e) => e.from_low_pct ?? 999,
    rsi: (e) => e.rsi ?? 999,
    low52: (e) => -(e.from_low_pct ?? -999),
    ret12: (e) => -(e.ret_12m ?? -999),
    ma200: (e) => -(e.ma200_dist_pct ?? -999),
  }[f.sort];
  rows = rows.slice().sort((a, b) => key(a) - key(b));

  $('all-count').textContent = `${rows.length}종목`;
  $('all-table').innerHTML = `
    <thead><tr>
      <th>종목</th><th>카테고리</th><th>현재가</th><th>저점대비</th><th>RSI</th>
      <th>200일선</th><th>1년</th><th>상태</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (e) => `<tr>
      <td><span class="c">${esc(e.code)}</span> <span class="mute">${esc(e.name.slice(0, 14))}</span></td>
      <td class="mute">${esc(e.category)}</td>
      <td>${fmtPrice(e.price, state.data.currency_label)}</td>
      <td class="${e.from_low_pct <= 10 ? 'pos' : ''}">${pct(e.from_low_pct)}</td>
      <td class="${e.rsi <= 50 ? 'pos' : ''}">${num(e.rsi, 1)}</td>
      <td class="${cls(e.ma200_dist_pct)}">${pct(e.ma200_dist_pct)}</td>
      <td class="${cls(e.ret_12m)}">${pct(e.ret_12m)}</td>
      <td>${
        e.signal.regime_pass
          ? '<span class="pill p">★약세</span>'
          : e.signal.raw_pass
            ? '<span class="pill r">원조건</span>'
            : '<span class="pill n">—</span>'
      }</td>
    </tr>`
      )
      .join('')}</tbody>`;
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

  const reasonRows = bear.trade_stats.reasons || {};
  $('bt-reasons').innerHTML = `
    <thead><tr><th>청산 사유</th><th>거래</th><th>평균</th><th>승률</th></tr></thead>
    <tbody>${Object.entries(reasonRows)
      .map(
        ([k, s]) =>
          `<tr><td class="c">${esc(k)}</td><td>${s.n}</td><td class="${cls(s.avg_pct)}">${pct(s.avg_pct, 2)}</td><td>${s.win_pct}%</td></tr>`
      )
      .join('')}</tbody>`;

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
      <h4>조건 2 — RSI(14) ${r.rsi_max} 이하</h4>
      <p>과열되지 않았다는 뜻입니다. RSI 50 을 넘으면 이미 반등이 진행된 상태로 봅니다.</p>
      <h4>두 조건을 같이 쓰는 이유</h4>
      <p>저점 근접만 보면 <b>계속 떨어지는 중</b>인 종목도 잡힙니다. RSI 조건이 그걸 걸러냅니다.
      둘을 같이 쓰면 <span class="em">바닥을 확인한 반등 후보</span>만 남습니다.</p>
      <div class="warnp">조건 통과만으로 사라는 뜻은 아닙니다. 백테스트에서 이 조건은
      지수를 이기지 못했습니다. "사람들이 떠난 지점이 어디인가"를 찾는 도구로 쓰세요.</div>
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

  const b = d.benchmark || {};
  $('g-regime').innerHTML = `
    <div class="guide">
      <h4>판정 기준</h4>
      <p>벤치마크(${esc(b.name || '지수')})의 <span class="em">최근 252거래일 수익률이 0% 미만</span>
      이면 약세 국면입니다.</p>
      <h4>왜 필터로 쓰나</h4>
      <p>10년 백테스트에서 이 조건만 걸면 연평균 수익이 <b>${state.backtest?.variants?.rsi60_plain?.portfolio?.cagr_pct ?? '—'}%</b> →
      약세 국면 한정으로 <b>${state.backtest?.variants?.rsi60_plain_bear?.portfolio?.cagr_pct ?? '—'}%</b> 로,
      최대 낙폭은 <b>${state.backtest?.variants?.rsi60_plain?.portfolio?.max_dd_pct ?? '—'}%</b> →
      <b>${state.backtest?.variants?.rsi60_plain_bear?.portfolio?.max_dd_pct ?? '—'}%</b> 로 나아집니다.</p>
      <div class="warnp">단, 투자 비중이 30%대로 떨어집니다.
      상승장에는 이 규칙으로 따라갈 자리가 없습니다. 그래서 화면에
      <b>원조건 신호도 함께</b> 보여줍니다. 판단은 본인 몫입니다.</div>
    </div>`;

  $('g-calc').innerHTML = `
    <div class="guide">
      <h4>52주 저·고점</h4>
      <p>최근 <span class="em">252거래일의 일봉 저가/고가</span> 를 씁니다.
      종가가 아니라 <b>장중 저가</b> 기준이라 실제 브로커 화면의 52주 최고·최저와
      대체로 일치합니다. 야후 메타의 52주 필드는 <b>한국 ETF 에서 0 을 반환</b>해서
      전부 직접 계산합니다.</p>
      <h4>RSI</h4>
      <p>Wilder 평활, 기간 14, 일봉 종가 기준. 6개월·1년·2년 어떤 구간으로 계산해도
      같은 값이 나옵니다.</p>
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

  $('mkt-btn').addEventListener('click', () => {
    const cfg = MARKETS[state.market];
    loadMarket(cfg.other);
  });

  $('theme-btn').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('etf-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  });
  if (localStorage.getItem('etf-theme') === 'dark') document.body.classList.add('dark');

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

  loadBacktest();
  loadMarket('us');
});
