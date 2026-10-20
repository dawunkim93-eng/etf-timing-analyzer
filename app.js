/* ETF 타이밍 분석 — 프런트엔드.
 * 외부 라이브러리 없음. 차트는 SVG 를 직접 그린다.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  market: 'us',
  data: null,
  backtest: null,
  depth: null,
  exitRsi: 60,
  stopPct: 15,
  filters: { cat: '', sort: 'signal', state: '', depth: '', depthAll: '' },
};

/* 낙폭 버킷 라벨 — universe.py 의 DEPTH_BUCKETS 와 같은 순서 */
const DEPTH_ORDER = ['15% 미만', '15~20%', '20~25%', '25~30%', '30~35%', '35~40%', '40%+'];
const DEPTH_SWEET = '30~35%';
const DEPTH_CRASH = '40%+';

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
  try {
    const res = await fetch('data/depth.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('없음');
    state.depth = await res.json();
  } catch {
    state.depth = null;
  }
  renderVerify();
  // 낙폭 설명은 depth.json 이 로드된 뒤에 채워진다
  if (state.data) renderGuide();
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
  $('data-status').innerHTML =
    `<span>갱신 ${esc(upd)} KST</span><span class="${stale ? 'stale' : ''}">` +
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

  renderBuy(etfs);
  renderSell(etfs);
  renderAll(etfs);
  renderGuide();
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
  return `<div class="sig">
    <div class="sig-top">
      <span class="sig-code">${esc(e.code)}</span>
      <span class="sig-name">${esc(e.name)}</span>
    </div>
    <div class="sig-tags" style="margin-top:6px">${tags.join('')}</div>
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
  let rows = etfs.filter((e) => {
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

  $('all-count').textContent = `${rows.length}종목`;
  $('all-table').innerHTML = `
    <thead><tr>
      <th>종목</th><th>카테고리</th><th>현재가</th><th>저점대비</th><th>RSI(14주)</th>
      <th>고점대비</th><th>200일선</th><th>1년</th><th>이력</th><th>상태</th>
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

  loadBacktest();
  loadMarket('us');
});
