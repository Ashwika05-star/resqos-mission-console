/* ResQ-OS Mission Console — UI layer.
 * Everything here only READS engine output (prepTasks / runSimulation / getResult / metrics).
 * No scheduling logic lives in this file. Derived views (battery curve, task states at time t)
 * are reconstructed from each result row's mode/start/finish plus the task's own energy fields. */
(function () {
'use strict';

/* ---------------- constants & labels ---------------- */
const SCENARIOS = [
  { key: 'scenario_1', label: 'Light' },
  { key: 'scenario_2', label: 'Medium' },
  { key: 'scenario_3', label: 'Heavy' },
];
const BASELINES = [
  { key: 'FCFS', label: 'FCFS', long: 'First-Come First-Served' },
  { key: 'SJF', label: 'SJF', long: 'Shortest Job First' },
  { key: 'EDF', label: 'EDF', long: 'Earliest Deadline First' },
  { key: 'Priority_RMS', label: 'Priority (RMS)', long: 'Rate-Monotonic priority, non-preemptive' },
  { key: 'SRT', label: 'SRT', long: 'Shortest Remaining Time (preempts local tasks)' },
  { key: 'RoundRobin', label: 'Round Robin', long: 'Round Robin, quantum 2 s (time-slices local tasks)' },
];
const RESQ = 'ResQ-OS';
const RAW = JSON.parse(document.getElementById('task-data').textContent);
const $ = id => document.getElementById(id);
const labelOf = k => k === RESQ ? 'ResQ-OS' : BASELINES.find(b => b.key === k).label;
const scenLabel = k => SCENARIOS.find(s => s.key === k).label;
const f1 = v => (isNaN(v) ? '—' : v.toFixed(1));
const pctTxt = v => (isNaN(v) ? '—' : (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1)));
const kJ = j => (j / 1000).toFixed(1) + ' kJ';
const secs = s => Math.round(s).toLocaleString('en-US') + ' s';
// Colours are read from the element being drawn, because the top scene and the lower area use different tokens.
let cssEl = document.documentElement;
const css = n => getComputedStyle(cssEl).getPropertyValue(n).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- simulation cache ---------------- */
const cache = new Map();
function scenarioInfo(scn) {
  const raw = RAW[scn];
  const allOffload = raw.reduce((s, t) => s + t.oe, 0);
  return {
    n: raw.length, util: SCENARIO_UTIL[scn], allOffload,
    allLocal: raw.reduce((s, t) => s + t.le, 0),
    budget: BUDGET_FRACTION * allOffload,
    lastArr: Math.max(...raw.map(t => t.arr)),
    lastDl: Math.max(...raw.map(t => t.dl)),
  };
}
function compute(scn, sched) {
  const key = scn + '|' + sched;
  if (cache.has(key)) return cache.get(key);
  const info = scenarioInfo(scn);
  const tasks = prepTasks(RAW[scn]);              // fresh copies every run (SRT/RR annotate tasks)
  const results = sched === RESQ
    ? runSimulation(tasks, sortKeyFor(RESQ), 'reserve_aware', info.budget)
    : getResult(sched, tasks, 'naive', info.budget);
  const byId = new Map(RAW[scn].map(t => [t.id, t]));
  const rows = results.map(r => {
    const t = byId.get(r.id);
    const cost = r.mode === 'offload' ? t.oe : r.mode === 'local_fallback' ? t.le : 0;
    return { ...r, arr: t.arr, dl: t.dl, cost };
  });
  // Battery is charged when the engine makes the run/offload decision, which is the row's start time.
  const ev = rows.filter(r => r.cost > 0).sort((a, b) => a.start - b.start);
  const evT = ev.map(r => r.start), evL = [];
  let lvl = info.budget; ev.forEach(r => { lvl -= r.cost; evL.push(lvl); });
  const count = m => rows.filter(r => r.mode === m).length;
  const done = rows.filter(r => r.mode !== 'failed');
  const out = {
    scn, sched, info, rows, byId: new Map(rows.map(r => [r.id, r])),
    m: metrics(results),
    offload: count('offload'), local: count('local_fallback'), failed: count('failed'),
    late: done.filter(r => !r.met).length, onTimeN: done.filter(r => r.met).length,
    end: Math.max(...rows.map(r => r.finish)),
    evT, evL, finalBattery: lvl,
    lanes: packLanes(rows),
  };
  cache.set(key, out);
  return out;
}
// SRT and RR time-share local tasks, so their start→finish spans overlap. Give overlapping bars separate lanes.
function packLanes(rows) {
  const ends = [], lane = new Map();
  rows.filter(r => r.mode !== 'failed').slice().sort((a, b) => a.start - b.start || a.finish - b.finish)
    .forEach(r => {
      let i = ends.findIndex(e => e <= r.start + 1e-9);
      if (i < 0) { i = ends.length; ends.push(0); }
      ends[i] = r.finish; lane.set(r.id, i);
    });
  return { n: Math.max(1, ends.length), of: lane };
}
function batteryAt(run, t) {
  let lo = 0, hi = run.evT.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (run.evT[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx < 0 ? run.info.budget : run.evL[idx];
}
function stateAt(r, t) {
  if (t < r.arr) return 'pending';
  if (r.mode === 'failed') return t >= r.start ? 'failed' : 'waiting';
  if (t < r.start) return 'waiting';
  if (t < r.finish) return 'running';
  return r.met ? 'ontime' : 'late';
}

/* ---------------- state ---------------- */
const S = {
  scn: 'scenario_3', base: 'FCFS', pickScn: 'scenario_3', pickBase: 'FCFS',
  A: null, B: null, T: 0, playing: false, speed: 1,
  win: { span: 300, start: 0 },
};
// A link like  #heavy-FCFS  opens that comparison directly (handy for screenshots).
function readHash() {
  try {
    const h = decodeURIComponent(location.hash.slice(1)).split(/[\/-]/);
    const sc = SCENARIOS.find(s => s.label.toLowerCase() === (h[0] || '').toLowerCase());
    const bl = BASELINES.find(b => b.key.toLowerCase() === (h[1] || '').toLowerCase());
    return sc && bl ? { scn: sc.key, base: bl.key } : null;
  } catch (e) { return null; }
}
const fromHash = readHash();
if (fromHash) { S.scn = S.pickScn = fromHash.scn; S.base = S.pickBase = fromHash.base; }
window.addEventListener('hashchange', () => {
  const h = readHash();
  if (h && (h.scn !== S.scn || h.base !== S.base)) runMission(h.scn, h.base, false);
});

/* ---------------- theme ---------------- */
// Two themes: 'stone' (light scene, the default) and 'dark'.
function setTheme(t) {
  document.documentElement.dataset.look = t; // own attribute, so it never fights the host's data-theme
  $('themeLbl').textContent = t === 'dark' ? 'Light' : 'Dark';
  $('themeBtn').setAttribute('aria-label', 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' theme');
  try { localStorage.setItem('resqos-theme-v2', t); } catch (e) {}
  if (S.A) drawAll();
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('resqos-theme-v2'); } catch (e) {}
setTheme(savedTheme === 'dark' ? 'dark' : 'stone');
$('themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.look === 'dark' ? 'stone' : 'dark'));

/* ---------------- controls ---------------- */
SCENARIOS.forEach(s => {
  const i = scenarioInfo(s.key);
  const l = document.createElement('label'); l.className = 'load';
  l.innerHTML = `<input type="radio" name="load" value="${s.key}"><span>${s.label} <small>${i.n} tasks · ${f1(i.util)}% util</small></span>`;
  $('loads').appendChild(l);
});
$('baseline').innerHTML = BASELINES.map(b => `<option value="${b.key}">${b.label}${b.key === 'RoundRobin' ? ' (q = 2 s)' : ''}</option>`).join('');
function syncPickers() {
  document.querySelectorAll('input[name=load]').forEach(r => { r.checked = r.value === S.pickScn; });
  $('baseline').value = S.pickBase;
  const stale = S.pickScn !== S.scn || S.pickBase !== S.base;
  $('runBtn').classList.toggle('stale', stale);
  $('staleNote').textContent = stale ? `Showing ${scenLabel(S.scn)} vs ${labelOf(S.base)}. Press Run to update.` : '';
}
$('loads').addEventListener('change', e => { S.pickScn = e.target.value; syncPickers(); });
$('baseline').addEventListener('change', e => { S.pickBase = e.target.value; syncPickers(); });
$('runBtn').addEventListener('click', () => runMission(S.pickScn, S.pickBase, true));

const SPEEDS = [0.5, 1, 2, 4];
$('speedSeg').innerHTML = SPEEDS.map(v => `<button type="button" data-v="${v}" aria-pressed="${v === 1}">${v}×</button>`).join('');
$('speedSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.speed = +b.dataset.v;
  $('speedSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
});

/* ---------------- run ---------------- */
function runMission(scn, base, animateIntro) {
  stop();
  S.scn = S.pickScn = scn; S.base = S.pickBase = base;
  S.A = compute(scn, RESQ); S.B = compute(scn, base);
  S.all = BASELINES.map(b => compute(scn, b.key));
  S.Tmax = Math.max(S.A.end, S.B.end);
  S.T = S.Tmax;
  // Default timeline window: shortly before the first moment either scheduler stops offloading.
  const firstSwitch = Math.min(...[S.A, S.B].flatMap(r => r.rows.filter(x => x.mode !== 'offload').map(x => x.start)), S.Tmax);
  S.win.start = Math.max(0, Math.min(firstSwitch - 20, S.Tmax - S.win.span));
  try { history.replaceState(null, '', '#' + scenLabel(scn).toLowerCase() + '-' + base); } catch (e) {}
  syncPickers();
  renderStatic();
  drawAll();
  if (animateIntro) { S.T = 0; play(); }
}

/* ---------------- static (per-run) rendering ---------------- */
function verdictText(A, B) {
  const bl = esc(labelOf(B.sched));
  const diff = +(+f1(A.m.onTime) - +f1(B.m.onTime)).toFixed(1);
  const keeps = A.failed === 0 ? 'completes every task' : `drops ${A.failed} tasks`;
  if (diff > 0) {
    return `ResQ-OS is <b>${diff.toFixed(1)} points ahead</b> on on-time completion (${f1(A.m.onTime)}% vs ${f1(B.m.onTime)}%) and <b>${keeps}</b> (${bl}: ${f1(B.m.completion)}%).`;
  }
  if (diff === 0) {
    return `ResQ-OS and ${bl} are <b>level</b> on on-time completion (${f1(A.m.onTime)}%), but ResQ-OS <b>${keeps}</b> (${bl}: ${f1(B.m.completion)}%).`;
  }
  return `${bl} is <b>${Math.abs(diff).toFixed(1)} points ahead</b> on on-time completion (${f1(B.m.onTime)}% vs ${f1(A.m.onTime)}%)` +
    (B.failed ? `, but drops ${B.failed} tasks; ResQ-OS <b>${keeps}</b>.` : '.');
}

function renderStatic() {
  const { A, B } = S, info = A.info, bl = labelOf(B.sched);
  $('navStatus').textContent = `${scenLabel(S.scn)} mission vs ${bl}`;
  $('heroChip').textContent = `${scenLabel(S.scn)} mission result`;
  $('heroTitle').innerHTML = A.m.completion > B.m.completion
    ? `<em>${pctTxt(A.m.completion)}%</em> of tasks completed`
    : `${pctTxt(A.m.onTime)}% of tasks on time`;
  $('verdict').innerHTML = verdictText(A, B);
  $('verdictNote').textContent = A.late ? `${A.late} of ResQ-OS's ${A.rows.length - A.failed} completed tasks finish after their deadline.` : '';

  // facts
  $('facts').innerHTML = [
    [info.n, 'Tasks'], [f1(info.util) + '%', 'Utilization (all offloaded)'],
    [kJ(info.budget), 'Battery budget'], [kJ(info.allOffload), 'All-offload energy'],
    [secs(info.lastDl), 'Last deadline in data'], [secs(A.end), 'ResQ-OS last finish'],
  ].map(([v, l]) => `<div><b class="num" style="font-family:var(--display)">${v}</b><span>${l}</span></div>`).join('');
  $('factsNote').textContent = `Budget = ${Math.round(BUDGET_FRACTION * 100)}% of all-offload energy · no recharge`;

  // pins (live counts filled in drawLive)
  $('pins').innerHTML = [['offload', 'Offloaded'], ['local', 'Run locally'], ['failed', 'Failed']].map(([k, l]) =>
    `<div class="pin"><div class="bub num" id="pin_${k}" style="background:var(--${k === 'local' ? 'local' : k})">0</div>` +
    `<div class="pl">${l}</div><div class="pb">${esc(bl)}: <i id="pinb_${k}">0</i></div></div>`).join('');
  $('clockEnd').textContent = '/ ' + secs(S.Tmax);
  $('scrub').max = Math.ceil(S.Tmax);

  // meters
  $('meters').innerHTML = [['A', 'ResQ-OS', 'var(--lime)'], ['B', bl, 'var(--base)']].map(([k, n, c]) =>
    `<div class="meter"><span style="color:${c};font-weight:600;min-width:6.5em">${esc(n)}</span>` +
    `<div class="cells" id="cells${k}" aria-hidden="true">${'<i></i>'.repeat(20)}</div><span class="num" id="mtr${k}"></span></div>`).join('');

  // legends
  $('batLegend').innerHTML = `<span><i class="sw line" style="background:var(--lime)"></i>ResQ-OS</span><span><i class="sw line" style="background:var(--base)"></i>${esc(bl)}</span><span><i class="sw line" style="background:var(--faint);height:2px"></i>Replay position</span>`;
  $('batCap').innerHTML = `Left at the end: ResQ-OS <b class="num">${kJ(A.finalBattery)}</b> · ${esc(bl)} <b class="num">${kJ(B.finalBattery)}</b>`;
  $('h2hLegend').innerHTML = `<span><i class="sw" style="background:var(--lime)"></i>ResQ-OS</span><span><i class="sw" style="background:var(--base)"></i>${esc(bl)}</span>`;
  $('bdNameB').textContent = bl;

  // gauges
  const gauge = (v, name, color) => {
    const r = 52, c = Math.PI * r, p = Math.max(0, Math.min(100, v)) / 100;
    return `<div class="gauge"><div class="gn" style="color:${color}">${esc(name)}</div>
      <svg viewBox="0 0 130 78" role="img" aria-label="${esc(name)} ${f1(v)} percent on time">
        <path d="M13 70 A52 52 0 0 1 117 70" fill="none" stroke="var(--panel3)" stroke-width="11" stroke-linecap="round"/>
        <path d="M13 70 A52 52 0 0 1 117 70" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}"/>
      </svg><div class="gv num" style="font-family:var(--display)">${f1(v)}%</div></div>`;
  };
  $('gauges').innerHTML = gauge(A.m.onTime, 'ResQ-OS', 'var(--lime)') + gauge(B.m.onTime, bl, 'var(--base)');

  renderH2H(); renderOutcomes(); renderSettings(); renderCompare(); renderTimelineControls(); renderMethod();
}

const why = (q, body) => `<details class="why"><summary>${q}</summary><div>${body}</div></details>`;

function renderH2H() {
  const { A, B } = S, bl = labelOf(B.sched);
  const defs = [
    ['Completion', 'completion', '%', '↑ better'],
    ['Deadline miss', 'missRate', '%', '↓ better'],
    ['Avg turnaround', 'avgResp', ' s', '↓ better'],
    ['On-time', 'onTime', '%', '↑ better'],
  ];
  const tiles = defs.map(([name, k, u, hint]) => {
    const a = A.m[k], b = B.m[k];
    const scale = k === 'avgResp' ? Math.max(a || 0, b || 0) || 1 : 100;
    const row = (who, v, color, cls) => `<div class="tv"><span class="${cls}">${esc(who)}</span><b class="num">${f1(v)}<small>${u.trim()}</small></b>
      <span class="tb"><i style="width:${isNaN(v) ? 0 : Math.max(1, 100 * v / scale)}%;background:${color}"></i></span></div>`;
    return `<div class="tile"><div class="tl"><span>${name}</span><span>${hint}</span></div>
      ${row('ResQ-OS', a, 'var(--lime)', 'rq')}${row(bl, b, 'var(--base)', 'bl')}</div>`;
  }).join('');
  $('h2h').innerHTML = `<div class="tiles">${tiles}</div>` +
    `<p class="note"><span class="pill">Tasks wait, but ${A.failed ? 'fewer' : 'none'} are dropped</span></p>` +
    why('Why is ResQ-OS’s turnaround time so long?',
      `After the offload budget is used, ResQ-OS runs the remaining tasks on-board, which is about 5× slower, so they queue. Its last task finishes at <b>${secs(A.end)}</b> vs ${secs(B.end)} for ${esc(bl)}. ` +
      `${esc(bl)}’s average only counts its ${B.rows.length - B.failed} completed tasks${B.failed ? `; its ${B.failed} dropped tasks are left out` : ''}. Miss rate is also over completed tasks only.`);
}

function splitBar(run) {
  const n = run.rows.length;
  const seg = (v, c, extra = '') => v ? `<i class="${extra}" style="width:${100 * v / n}%;background:var(--${c})" title=""></i>` : '';
  return `<div class="split" role="img" aria-label="${run.offload} offloaded, ${run.local} run locally, ${run.failed} failed">${seg(run.offload, 'offload')}${seg(run.local, 'local')}${seg(run.failed, 'failed', 'hatch')}</div>`;
}
function renderOutcomes() {
  const { A, B } = S;
  const stat = (n, c, label, hatch) => `<div><i class="sw${hatch ? ' hatch' : ''}" style="background:var(--${c})"></i><b class="num">${n}</b><span>${label}</span></div>`;
  const block = run => `<div class="oc"><div class="och"><span class="${run.sched === RESQ ? 'rq' : 'bl'}">${esc(labelOf(run.sched))}</span>
      <span class="small faint num">${run.onTimeN} on time · ${run.late} late</span></div>${splitBar(run)}
    <div class="ocs">${stat(run.offload, 'offload', 'offloaded')}${stat(run.local, 'local', 'local')}${stat(run.failed, 'failed', 'failed', true)}</div></div>`;
  $('outcomes').innerHTML = block(A) + block(B) +
    why('Offload or local?', 'Offloading to the edge server is about 5× faster but costs about 28× more energy. The battery budget decides how many tasks can be offloaded; a task fails only when even running it locally is unaffordable.');
}
function renderSettings() {
  const info = S.A.info;
  const w = v => `<span class="wbar"><span class="cells" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i style="${i < Math.round(v * 10) ? 'background:var(--lime)' : ''}"></i>`).join('')}</span><span class="tag">${v}</span></span>`;
  $('settings').innerHTML = [
    ['Task ordering', '<span class="tag">Urgency score</span>'],
    ['Period weight', w(W_PERIOD)],
    ['Slack weight', w(W_SLACK)],
    ['Battery policy', '<span class="tag">Reserve-aware</span>'],
    ['Battery budget', `<span class="tag">${kJ(info.budget)} (${Math.round(BUDGET_FRACTION * 100)}%)</span>`],
    ['Recharge', '<span class="tag">None</span>'],
    ['Baselines run with', '<span class="tag">Greedy battery policy</span>'],
  ].map(([k, v]) => `<div class="cfg"><span>${k}</span>${v}</div>`).join('') +
    why('How do these work?', `<b>Urgency score</b> = ${W_PERIOD}·inv_norm(Period) + ${W_SLACK}·inv_norm(Slack); most urgent first, ties by arrival.<br>` +
      `<b>Reserve-aware</b>: offload only if the battery left afterwards still covers running every unfinished task locally.`);
}

function renderCompare() {
  const all = [S.A, ...S.all];
  const best = {
    completion: Math.max(...all.map(r => +f1(r.m.completion))),
    missRate: Math.min(...all.map(r => +f1(r.m.missRate))),
    avgResp: Math.min(...all.map(r => +f1(r.m.avgResp))),
    onTime: Math.max(...all.map(r => +f1(r.m.onTime))),
  };
  const cell = (r, k, u, bar) => {
    const v = r.m[k], isBest = +f1(v) === best[k];
    const b = bar ? `<span class="ib" aria-hidden="true"><i style="width:${v}%;background:${r.sched === RESQ ? 'var(--lime)' : 'var(--base)'}"></i></span>` : '';
    return `<td class="num${isBest ? ' best' : ''}">${b}${f1(v)}${u}</td>`;
  };
  $('cmpTbl').innerHTML = `<caption class="sr">All schedulers on the ${scenLabel(S.scn)} mission. Star marks the best value in each column.</caption>
    <thead><tr><th scope="col">Scheduler</th><th scope="col">Completion</th><th scope="col">Deadline miss</th><th scope="col">Avg turnaround</th><th scope="col">Overall on-time</th><th scope="col">Offload / local / failed</th><th scope="col">Last finish</th></tr></thead>
    <tbody>${all.map(r => {
      const isA = r.sched === RESQ, isCur = r.sched === S.base;
      const name = isA ? '<span class="rq">ResQ-OS</span>'
        : `<button class="linkbtn" type="button" data-base="${r.sched}" ${isCur ? 'disabled aria-current="true"' : ''} title="${esc(BASELINES.find(b => b.key === r.sched).long)}">${esc(labelOf(r.sched))}</button>${isCur ? ' <span class="pill sm">vs</span>' : ''}`;
      return `<tr class="${isA ? 'me' : isCur ? 'cur' : ''}"><th scope="row" style="text-align:left;font-size:.86rem;text-transform:none;letter-spacing:0;background:transparent;color:var(--text)">${name}</th>
        ${cell(r, 'completion', '%', true)}${cell(r, 'missRate', '%')}${cell(r, 'avgResp', ' s')}${cell(r, 'onTime', '%', true)}
        <td class="num">${r.offload} / ${r.local} / ${r.failed}</td><td class="num">${secs(r.end)}</td></tr>`;
    }).join('')}</tbody>`;
  const sorted = all.slice().sort((a, b) => b.m.onTime - a.m.onTime);
  const rank = sorted.findIndex(r => r.sched === RESQ) + 1;
  const ahead = sorted.slice(0, rank - 1).map(r => `${labelOf(r.sched)} (${f1(r.m.onTime)}%)`);
  const topCompl = Math.max(...all.map(r => +f1(r.m.completion))) === +f1(S.A.m.completion);
  $('cmpSub').textContent = `${scenLabel(S.scn)} mission · ${S.A.info.n} tasks · ${kJ(S.A.info.budget)} battery each · click a name to compare`;
  $('cmpNote').innerHTML = `<p class="note"><span class="pill">On-time rank: ResQ-OS ${rank} of 7</span>` +
    (topCompl ? `<span class="pill">Highest completion: ${f1(S.A.m.completion)}%</span>` : '') + `<span class="pill">★ best in column</span></p>` +
    why('How to read this table', (ahead.length ? `Ahead of ResQ-OS on on-time: ${ahead.map(esc).join(', ')}. ` : '') +
      `ResQ-OS uses its reserve-aware battery policy; every baseline uses the greedy one. Miss rate and turnaround time are averaged over each scheduler's <b>completed</b> tasks only, so a scheduler that drops many tasks can look fast.`);
}
$('cmpTbl').addEventListener('click', e => {
  const b = e.target.closest('button[data-base]'); if (!b || b.disabled) return;
  runMission(S.scn, b.dataset.base, false);
  document.getElementById('mission').scrollIntoView({ behavior: 'smooth' });
});

function renderMethod() {
  $('methodBody').innerHTML = `
    <div><h4>Completion rate</h4>Completed tasks ÷ all tasks. A task fails only when the battery cannot pay for it at all.</div>
    <div><h4>Deadline miss rate</h4>Late tasks ÷ <b>completed</b> tasks. Dropped tasks are not in this figure.</div>
    <div><h4>Avg turnaround time</h4>Mean of <code>finish − arrival</code> over completed tasks: the standard OS turnaround time. (The engine's field is named <code>resp</code>, but it measures turnaround, not response time.)</div>
    <div><h4>Overall on-time</h4><code>completion × (1 − miss/100)</code>: share of all tasks that finished by their deadline. This is the fairest single number.</div>
    <div><h4>Battery curve</h4>Rebuilt from the engine's output: each task's energy (offload or local) is subtracted at the moment the engine decided how to run it.</div>
    <div><h4>Why ResQ-OS runs long</h4>When offloading would eat into the energy needed to finish everything locally, ResQ-OS runs tasks on-board instead. Local is ~5× slower, so the queue stretches past the last deadline.</div>
    <div><h4>SRT and Round Robin bars</h4>These preempt or time-slice local tasks. The engine records first admission and finish only, so their timeline bars span that whole interval and overlap; they are stacked in lanes.</div>
    <div><h4>Moving scenery</h4>The landscape is generated terrain that the camera flies into as the replay clock runs. It is decoration only and carries no data.</div>
    <div><h4>Data</h4>3D-UAV-MEC task set. Light / Medium / Heavy = ${SCENARIOS.map(s => RAW[s.key].length).join(' / ')} tasks. Utilization is the engine's constant for each scenario (total offload time ÷ mission span).</div>`;
}

/* ---------------- canvas helpers ---------------- */
function fit(cv, h) {
  const w = Math.max(10, cv.clientWidth), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cssEl = cv; // transparent background; PNG export adds a solid one
  return { ctx, w, h };
}
function niceTicks(a, b, n) {
  const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
  const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(v);
  return out;
}
const tip = $('tip');
function showTip(e, html) {
  tip.innerHTML = html; tip.style.display = 'block';
  const pad = 14, r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };

/* ---------------- battery chart ---------------- */
const bat = { geo: null, range: 'all' };
$('batSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  bat.range = b.dataset.v;
  $('batSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  drawBattery();
});
function drawBattery() {
  const cv = $('batCv'), { ctx, w, h } = fit(cv, 190);
  const L = 44, R = 10, T = 10, B = 26, pw = w - L - R, ph = h - T - B, budget = S.A.info.budget;
  const Tm = bat.range === 'dl' ? Math.min(S.Tmax, Math.ceil(S.A.info.lastDl)) : S.Tmax;
  const X = t => L + pw * t / Tm, Y = v => T + ph * (1 - v / budget);
  bat.geo = { L, pw, Tm, X, Y };
  ctx.font = '11px ' + css('--mono'); ctx.fillStyle = css('--faint'); ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(p => {
    const y = Math.round(Y(budget * p)) + 0.5;
    ctx.beginPath(); ctx.setLineDash([2, 4]); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText((p * 100) + '%', L - 6, y);
  });
  ctx.textBaseline = 'top';
  niceTicks(0, Tm, Math.max(2, Math.floor(pw / 80))).forEach(t => {
    ctx.textAlign = 'center'; ctx.fillText(Math.round(t) + 's', Math.min(Math.max(X(t), L + 12), w - 18), h - B + 8);
  });
  ctx.save(); ctx.beginPath(); ctx.rect(L - 5, 0, pw + 10, h); ctx.clip();
  const line = (run, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
    ctx.moveTo(X(0), Y(budget)); let last = budget;
    run.evT.forEach((t, i) => { ctx.lineTo(X(t), Y(last)); ctx.lineTo(X(t), Y(run.evL[i])); last = run.evL[i]; });
    ctx.lineTo(X(run.end), Y(last)); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(run.end), Y(last), 3.5, 0, 7); ctx.fill();
  };
  line(S.B, css('--base')); line(S.A, css('--lime')); ctx.restore();
  // playhead
  if (S.T < S.Tmax && S.T <= Tm) {
    const x = Math.round(X(S.T)) + 0.5;
    ctx.strokeStyle = css('--faint'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke(); ctx.setLineDash([]);
  }
  if (bat.hoverT != null) {
    const x = Math.round(X(bat.hoverT)) + 0.5;
    ctx.strokeStyle = css('--dim'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
    [[S.B, '--base'], [S.A, '--lime']].forEach(([run, c]) => {
      if (bat.hoverT > run.end) return;
      ctx.fillStyle = css(c); ctx.strokeStyle = css('--panel'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, Y(batteryAt(run, bat.hoverT)), 4.5, 0, 7); ctx.fill(); ctx.stroke();
    });
  }
  cv.setAttribute('aria-label', `Battery remaining over time. ResQ-OS ends with ${kJ(S.A.finalBattery)} at ${secs(S.A.end)}; ${labelOf(S.B.sched)} ends with ${kJ(S.B.finalBattery)} at ${secs(S.B.end)}.`);
}
function batT(e) {
  const g = bat.geo, r = $('batCv').getBoundingClientRect();
  return Math.max(0, Math.min(g.Tm, (e.clientX - r.left - g.L) / g.pw * g.Tm));
}
$('batCv').addEventListener('pointermove', e => {
  if (!bat.geo) return;
  const t = batT(e); bat.hoverT = t; drawBattery();
  const row = (run, cls) => {
    const v = batteryAt(run, t), done = t > run.end;
    return `<div><span class="${cls}">${esc(labelOf(run.sched))}</span> <span class="num">${kJ(v)} (${f1(100 * v / run.info.budget)}%)</span>${done ? ' <span class="faint">finished</span>' : ''}</div>`;
  };
  showTip(e, `<div class="num faint">t = ${secs(t)}</div>${row(S.A, 'rq')}${row(S.B, 'bl')}<div class="faint small">Click to move the replay here</div>`);
});
$('batCv').addEventListener('pointerleave', () => { bat.hoverT = null; hideTip(); drawBattery(); });
$('batCv').addEventListener('click', e => { if (bat.geo) { stop(); setT(batT(e)); } });

/* ---------------- task boards ---------------- */
const boards = { A: null, B: null };
function boardGlyph(ctx, st, mode, x, y, d) {
  const c = mode === 'offload' ? css('--offload') : mode === 'local_fallback' ? css('--local') : css('--failed');
  const r = d / 2, cx = x + r, cy = y + r;
  switch (st) {
    case 'pending': ctx.fillStyle = css('--panel3'); ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, r * 0.35), 0, 7); ctx.fill(); break;
    case 'waiting': ctx.strokeStyle = css('--dim'); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(cx, cy, r - 1.2, 0, 7); ctx.stroke(); break;
    case 'running':
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, 7); ctx.fill();
      ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, r + 1.2, 0, 7); ctx.stroke(); break;
    case 'ontime': ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, 7); ctx.fill(); break;
    case 'late':
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, 7); ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, r * 0.28), 0, 7); ctx.fill(); break;
    case 'failed': {
      const k = r * 0.62; ctx.strokeStyle = css('--failed'); ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - k, cy - k); ctx.lineTo(cx + k, cy + k); ctx.moveTo(cx + k, cy - k); ctx.lineTo(cx - k, cy + k); ctx.stroke(); break;
    }
  }
}
function drawBoard(which) {
  const run = S[which], cv = $('board' + which), w = Math.max(10, cv.clientWidth), order = RAW[S.scn];
  const n = order.length, gap = 3;
  let d = 13; while (d > 6 && Math.ceil(n / Math.floor((w + gap) / (d + gap))) * (d + gap) > 190) d--;
  const cols = Math.max(1, Math.floor((w + gap) / (d + gap))), rowsN = Math.ceil(n / cols);
  const { ctx } = fit(cv, rowsN * (d + gap) + 4);
  const cnt = { pending: 0, waiting: 0, running: 0, ontime: 0, late: 0, failed: 0 };
  order.forEach((t, i) => {
    const r = run.byId.get(t.id), st = stateAt(r, S.T); cnt[st]++;
    boardGlyph(ctx, st, r.mode, (i % cols) * (d + gap) + 2, Math.floor(i / cols) * (d + gap) + 2, d);
  });
  boards[which] = { d, gap, cols, order };
  // Only show the states that currently have tasks, so the line stays short.
  const lbl = { pending: 'not arrived', waiting: 'waiting', running: 'running', ontime: 'on time', late: 'late', failed: 'failed' };
  $('bstats' + which).innerHTML = Object.keys(lbl).filter(k => cnt[k]).map(k => `<span><b>${cnt[k]}</b> ${lbl[k]}</span>`).join('');
  $('bdTime' + which).textContent = S.T >= run.end ? `finished at ${secs(run.end)}` : `t = ${secs(S.T)}`;
  cv.setAttribute('aria-label', `${labelOf(run.sched)} at ${secs(S.T)}: ${cnt.ontime} on time, ${cnt.late} late, ${cnt.running} running, ${cnt.waiting} waiting, ${cnt.failed} failed, ${cnt.pending} not yet arrived.`);
}
const STATE_TXT = { pending: 'Not arrived yet', waiting: 'Waiting in queue', running: 'Running', ontime: 'Done on time', late: 'Done after deadline', failed: 'Failed (no battery)' };
const MODE_TXT = { offload: 'Offload', local_fallback: 'Local', failed: '—' };
['A', 'B'].forEach(which => {
  const cv = $('board' + which);
  cv.addEventListener('pointermove', e => {
    const b = boards[which]; if (!b) return;
    const rc = cv.getBoundingClientRect(), x = e.clientX - rc.left - 2, y = e.clientY - rc.top - 2;
    const c = Math.floor(x / (b.d + b.gap)), rr = Math.floor(y / (b.d + b.gap)), i = rr * b.cols + c;
    if (c < 0 || c >= b.cols || i < 0 || i >= b.order.length) return hideTip();
    const r = S[which].byId.get(b.order[i].id);
    showTip(e, taskTip(r, S[which]) + `<div class="faint">At t = ${secs(S.T)}: ${STATE_TXT[stateAt(r, S.T)]}</div>`);
  });
  cv.addEventListener('pointerleave', hideTip);
});
function taskTip(r, run) {
  const late = r.mode !== 'failed' && !r.met ? ` (${f1(r.finish - r.dl)} s late)` : '';
  return `<div><b>${esc(r.id)}</b> · <span class="${run.sched === RESQ ? 'rq' : 'bl'}">${esc(labelOf(run.sched))}</span></div>
    <div class="num small">arrive ${f1(r.arr)} s · deadline ${f1(r.dl)} s</div>` +
    (r.mode === 'failed' ? `<div style="color:var(--failed)">Dropped at ${f1(r.start)} s: battery could not pay for it</div>`
      : `<div class="num small">${MODE_TXT[r.mode]} · ${f1(r.start)} → ${f1(r.finish)} s</div><div>${r.met ? 'On time' : 'Missed deadline' + late}</div>`);
}
const glyphSvg = st => {
  const m = { pending: '<circle cx="6" cy="6" r="2" fill="var(--panel3)"/>', waiting: '<circle cx="6" cy="6" r="4.6" fill="none" stroke="var(--dim)" stroke-width="1.2"/>',
    running: '<circle cx="6" cy="6" r="3.8" fill="var(--offload)"/><circle cx="6" cy="6" r="5.3" fill="none" stroke="var(--text)" stroke-width="1.2"/>',
    ontime: '<circle cx="6" cy="6" r="5" fill="var(--offload)"/><path d="M6 1a5 5 0 0 1 0 10z" fill="var(--local)"/>',
    late: '<circle cx="6" cy="6" r="4.3" fill="none" stroke="var(--local)" stroke-width="1.8"/><circle cx="6" cy="6" r="1.4" fill="var(--local)"/>',
    failed: '<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="var(--failed)" stroke-width="2" stroke-linecap="round"/>' }[st];
  return `<svg class="glyph" viewBox="0 0 12 12" aria-hidden="true">${m}</svg>`;
};
$('boardLegend').innerHTML = ['pending', 'waiting', 'running', 'ontime', 'late', 'failed'].map(s => `<span>${glyphSvg(s)}${STATE_TXT[s]}</span>`).join('') +
  `<span><i class="sw" style="background:var(--offload)"></i>Offload</span><span><i class="sw" style="background:var(--local)"></i>Local</span>`;

/* ---------------- playback ---------------- */
const PLAY_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3l10 6-10 6z" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor"/></svg>';
const REPLAY_SECONDS = 24; // 1× speed replays the whole mission in about this many real seconds
let raf = 0, lastTs = 0;
function play() {
  if (S.T >= S.Tmax - 1e-6) S.T = 0;
  S.playing = true; lastTs = 0; $('hero').classList.add('flying'); updatePlayBtn();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
}
function stop() {
  S.playing = false; cancelAnimationFrame(raf); $('hero').classList.remove('flying'); updatePlayBtn(); if (S.A) drawScenery();
}
function tick(ts) {
  if (!S.playing) return;
  if (lastTs) S.T = Math.min(S.Tmax, S.T + (ts - lastTs) / 1000 * S.Tmax / REPLAY_SECONDS * S.speed);
  lastTs = ts; drawLive();
  if (S.T >= S.Tmax) { stop(); drawLive(); return; }
  raf = requestAnimationFrame(tick);
}
function updatePlayBtn() {
  $('playBtn').innerHTML = S.playing ? PAUSE_SVG : PLAY_SVG;
  $('playBtn').setAttribute('aria-label', S.playing ? 'Pause mission replay' : (S.T >= S.Tmax ? 'Replay mission from the start' : 'Play mission replay'));
}
function setT(t) { S.T = Math.max(0, Math.min(S.Tmax, t)); drawLive(); }
$('playBtn').addEventListener('click', () => (S.playing ? stop() : play()));
$('scrub').addEventListener('input', e => { stop(); setT(+e.target.value); });
document.addEventListener('keydown', e => {
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); S.playing ? stop() : play(); }
});

function drawLive() {
  const { A, B, T } = S;
  const sc = $('scrub'); sc.value = Math.round(T); sc.style.setProperty('--p', (100 * T / S.Tmax) + '%');
  sc.setAttribute('aria-valuetext', secs(T));
  $('clock').textContent = secs(T);
  // pins: decisions made so far
  const so = (run, mode) => run.rows.filter(r => r.mode === mode && r.start <= T).length;
  [['offload', 'offload'], ['local', 'local_fallback'], ['failed', 'failed']].forEach(([k, m]) => {
    $('pin_' + k).textContent = so(A, m); $('pinb_' + k).textContent = so(B, m);
  });
  [['A', A], ['B', B]].forEach(([k, run]) => {
    const v = batteryAt(run, T), p = v / run.info.budget, on = Math.round(p * 20);
    const color = k === 'A' ? 'var(--lime)' : 'var(--base)';
    $('cells' + k).querySelectorAll('i').forEach((c, i) => { c.style.background = i < on ? color : ''; });
    $('mtr' + k).textContent = `${kJ(v)} · ${f1(100 * p)}%`;
  });
  updatePlayBtn();
  drawBoard('A'); drawBoard('B'); drawBattery(); drawGantt(); drawScenery();
}


/* ---------------- moving scenery (decoration only, carries no data) ----------------
 * A small "voxel space" terrain flyover (the technique used by early flight games).
 * The terrain is generated once from a fixed seed, so it looks the same every time.
 * How far the camera has flown forward = mission clock × a constant, so play, pause and
 * scrubbing all move the landscape consistently. Nothing here is read from the task data. */
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const CELLS_PER_MISSION_SECOND = 0.2;
const MAP = 512, MASK = MAP - 1;
let terrain = null; // { h: heights 0..1, r, g, b: base colours }

function ihash(x, y, seed) { // integer hash → 0..1
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, period, seed) { // tileable value noise
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period, y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = ihash(x0, y0, seed), b = ihash(x1, y0, seed), c = ihash(x0, y1, seed), d = ihash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function buildTerrain() {
  const h = new Float32Array(MAP * MAP);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    let sum = 0, amp = 1, norm = 0, ridged = 0;
    for (let o = 0, cell = 128; o < 5; o++, cell /= 2) {
      const n = vnoise(x / cell, y / cell, MAP / cell, 7 + o);
      sum += n * amp; ridged += (1 - Math.abs(n * 2 - 1)) * amp; norm += amp; amp *= 0.45;
    }
    h[y * MAP + x] = Math.pow(sum / norm, 1.8) * 0.7 + Math.pow(ridged / norm, 2.5) * 0.3;
  }
  // two passes of a 3×3 blur: rounder hills, no needle-like spikes
  for (let pass = 0; pass < 2; pass++) {
    const src = h.slice();
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      let t = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) t += src[((y + j) & MASK) * MAP + ((x + i) & MASK)];
      h[y * MAP + x] = t / 9;
    }
  }
  for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / (hi - lo);
  const r = new Uint8Array(MAP * MAP), g = new Uint8Array(MAP * MAP), b = new Uint8Array(MAP * MAP);
  const H = (x, y) => h[(y & MASK) * MAP + (x & MASK)];
  const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
  const WATER = [70, 92, 100], GRASS = [96, 110, 58], FOREST = [46, 62, 36], SCRUB = [108, 100, 72], ROCK = [104, 98, 88], SNOW = [240, 240, 236];
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const v = H(x, y), sx = H(x + 1, y) - H(x - 1, y), sy = H(x, y + 1) - H(x, y - 1), slope = Math.hypot(sx, sy) * 40;
    const grain = ihash(x, y, 99) * 0.06 - 0.03, patch = vnoise(x / 8, y / 8, MAP / 8, 50);
    let c;
    if (v < 0.13) c = WATER;
    else if (v < 0.38) c = mix(GRASS, FOREST, Math.min(1, patch * 1.4));
    else if (v < 0.6) c = mix(FOREST, SCRUB, (v - 0.38) / 0.22);
    else if (v < 0.84) c = mix(SCRUB, ROCK, (v - 0.6) / 0.24);
    else c = mix(ROCK, SNOW, Math.min(1, (v - 0.84) / 0.08));
    if (v >= 0.13 && slope > 0.8) c = mix(c, ROCK, Math.min(0.5, (slope - 0.8) * 0.5)); // steep faces show rock
    const light = v < 0.13 ? 1 : Math.max(0.72, Math.min(1.2, 1 + (sx * 0.8 + sy * 0.5) * -9)) + grain;
    const i = y * MAP + x;
    r[i] = Math.min(255, c[0] * light); g[i] = Math.min(255, c[1] * light); b[i] = Math.min(255, c[2] * light);
  }
  terrain = { h, r, g, b };
}
function rgbOf(cssColor) { // "#rrggbb" or "rgb(...)" → [r,g,b]
  const m = cssColor.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  const n = cssColor.match(/\d+(\.\d+)?/g) || [0, 0, 0]; return n.slice(0, 3).map(Number);
}
function camAt(travel) { // camera path: forward along -y, gentle S-curves in x
  return { x: 256 + Math.sin(travel / 260) * 90, y: -travel, heading: Math.cos(travel / 260) * 0.35 };
}
function terrainAt(x, y) { return terrain.h[((Math.floor(y) & MASK) * MAP) + (Math.floor(x) & MASK)]; }
function drawSceneryOn(cv) {
  if (!cv || !cv.offsetParent) return; // hidden at this screen size
  if (!terrain) buildTerrain();
  const cw = Math.max(10, cv.clientWidth), ch = Math.max(10, cv.clientHeight);
  const W = Math.min(640, Math.round(cw / 2)), Hh = Math.max(40, Math.round(W * ch / cw)); // low-res render, scaled up softly
  if (cv.width !== W || cv.height !== Hh) { cv.width = W; cv.height = Hh; }
  const ctx = cv.getContext('2d'); cssEl = cv;
  const fog = rgbOf(css('--haze')), base = rgbOf(css('--mtn4')), k = parseFloat(css('--terrain-k')) || 1;
  const travel = reduceMotion || !S.A ? 0 : S.T * CELLS_PER_MISSION_SECOND;
  const cam = camAt(travel), sinA = Math.sin(cam.heading), cosA = Math.cos(cam.heading);
  const ground = Math.max(terrainAt(cam.x, cam.y), terrainAt(cam.x - sinA * 40, cam.y - cosA * 40));
  const HS = 105, camH = ground * HS + 62, horizon = Hh * 0.34, scale = Hh * 0.62, FAR = 560;
  const img = ctx.createImageData(W, Hh), px = new Uint32Array(img.data.buffer), ybuf = new Float32Array(W).fill(Hh);
  const { h, r, g, b } = terrain;
  for (let z = 3, dz = 0.4; z < FAR; z += dz, dz *= 1.011) {
    let plx = -cosA * z - sinA * z, ply = sinA * z - cosA * z;
    const prx = cosA * z - sinA * z, pry = -sinA * z - cosA * z;
    const dx = (prx - plx) / W, dy = (pry - ply) / W;
    plx += cam.x; ply += cam.y;
    const f = Math.min(1, Math.pow(z / FAR, 1.75)); // distance haze: clear up close, misty far away
    const inv = scale / z;
    for (let i = 0; i < W; i++, plx += dx, ply += dy) {
      const idx = ((Math.floor(ply) & MASK) * MAP) + (Math.floor(plx) & MASK);
      let sy = (camH - h[idx] * HS) * inv + horizon;
      if (sy < ybuf[i]) {
        if (sy < 0) sy = 0;
        const R = (r[idx] * k) * (1 - f) + fog[0] * f, G = (g[idx] * k) * (1 - f) + fog[1] * f, B = (b[idx] * k) * (1 - f) + fog[2] * f;
        const col = 0xff000000 | (B << 16) | (G << 8) | R;
        for (let y = sy | 0, e = ybuf[i] | 0; y < e; y++) px[y * W + i] = col;
        ybuf[i] = sy;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  // fade the nearest ground into the dark strip below the scene
  const grd = ctx.createLinearGradient(0, Hh * 0.72, 0, Hh);
  grd.addColorStop(0, `rgba(${base[0]},${base[1]},${base[2]},0)`); grd.addColorStop(1, `rgb(${base[0]},${base[1]},${base[2]})`);
  ctx.fillStyle = grd; ctx.fillRect(0, Hh * 0.72, W, Hh * 0.28);
}
function drawScenery() {
  drawSceneryOn($('ridgeCv')); drawSceneryOn($('heroRidgeCv'));
  // the drone banks into the camera path's turns and drifts slightly; the beam follows it
  const travel = reduceMotion || !S.A ? 0 : S.T * CELLS_PER_MISSION_SECOND;
  const live = S.playing && !reduceMotion;
  const turn = Math.cos(travel / 260); // matches camAt()'s S-curve
  const dx = live ? turn * 10 : 0, roll = live ? -turn * 5 : 0, pitch = live ? 0.97 : 1;
  const g = $('droneSway');
  g.style.transformOrigin = '400px 150px';
  g.style.transform = `translate(${dx.toFixed(1)}px,0) rotate(${roll.toFixed(2)}deg) scale(1,${pitch})`;
  $('beamPoly').setAttribute('points', `${392 + dx},196 ${408 + dx},196 ${520 + dx * 2.2},330 ${280 + dx * 2.2},330`);
  $('beamGlow').setAttribute('cx', 400 + dx * 2.2);
}

/* ---------------- timeline (Gantt) ---------------- */
const SPANS = [[60, '60 s'], [300, '300 s'], [1000, '1,000 s'], [0, 'Full']];
$('spanSeg').innerHTML = SPANS.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === 300}">${l}</button>`).join('');
$('spanSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const centre = S.win.start + effSpan() / 2;
  S.win.span = +b.dataset.v;
  $('spanSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  setWin(centre - effSpan() / 2);
});
const effSpan = () => (S.win.span && S.win.span < S.Tmax ? S.win.span : S.Tmax);
function setWin(start) {
  S.win.start = Math.max(0, Math.min(start, S.Tmax - effSpan()));
  syncWinSlider(); drawGantt();
}
function syncWinSlider() {
  const s = $('winStart'), max = Math.max(0, Math.floor(S.Tmax - effSpan()));
  s.max = max; s.value = Math.round(S.win.start); s.disabled = max === 0;
  s.style.setProperty('--p', max ? (100 * S.win.start / max) + '%' : '0%');
  $('winLbl').textContent = `${secs(S.win.start)} – ${secs(S.win.start + effSpan())}`;
}
$('winStart').addEventListener('input', e => { S.win.start = +e.target.value; syncWinSlider(); drawGantt(); });

function renderTimelineControls() {
  const { A, B } = S, bl = labelOf(B.sched), jumps = [];
  const firstOf = (run, pred) => { const x = run.rows.filter(pred).map(r => r.start); return x.length ? Math.min(...x) : null; };
  const aLocal = firstOf(A, r => r.mode === 'local_fallback');
  if (aLocal != null) jumps.push(['ResQ-OS starts running locally', aLocal]);
  const bFail = firstOf(B, r => r.mode === 'failed');
  if (bFail != null) jumps.push([`${bl} drops its first task`, bFail]);
  jumps.push(['Last deadline in data', A.info.lastDl]);
  jumps.push(['ResQ-OS finishes', A.end]);
  $('jumps').innerHTML = jumps.map(([l, t]) => `<button class="btn" type="button" data-t="${t}">${esc(l)} <span class="num faint">${secs(t)}</span></button>`).join('');
  $('ganttLegend').innerHTML = `<span><i class="sw" style="background:var(--offload)"></i>Offload</span><span><i class="sw" style="background:var(--local)"></i>Local</span>` +
    `<span>${glyphSvg('failed')}Failed (no battery)</span><span><i class="sw" style="background:transparent;border:1.5px dashed var(--dim)"></i>Task deadline (on hover)</span><span>› bar continues outside window</span>`;
  const ov = [A, B].filter(r => r.lanes.n > 1);
  $('ganttNote').innerHTML = ov.length ? why(`Why do ${esc(ov.map(r => labelOf(r.sched)).join(' and '))} bars overlap?`,
    'These schedulers time-share local tasks. The engine records only when a task was admitted and when it finished, so each bar spans that whole interval and overlapping bars are stacked in lanes.') : '';
  syncWinSlider();
}
$('jumps').addEventListener('click', e => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  setWin(+b.dataset.t - effSpan() * 0.25);
});

const gantt = { hits: [], hover: null };
function drawGantt() {
  if (!S.A) return;
  const cv = $('ganttCv'), w = Math.max(10, cv.clientWidth);
  const ws = S.win.start, sp = effSpan(), we = ws + sp;
  const L = 8, R = 8, pw = w - L - R, X = t => L + pw * (t - ws) / sp;
  const tracks = [S.A, S.B].map(run => {
    const laneH = Math.max(4, Math.min(22, Math.floor(150 / run.lanes.n)));
    return { run, laneH, h: 20 + 14 + laneH * run.lanes.n + 18 };
  });
  const H = tracks.reduce((s, t) => s + t.h, 0) + 24;
  const { ctx } = fit(cv, H);
  gantt.hits = [];
  ctx.font = '11px ' + css('--mono');
  let y = 0;
  const gridTicks = niceTicks(ws, we, Math.max(2, Math.floor(pw / 90)));
  tracks.forEach(({ run, laneH, h }) => {
    const isA = run.sched === RESQ;
    ctx.font = '600 13px ' + css('--body'); ctx.fillStyle = css(isA ? '--lime' : '--base'); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(labelOf(run.sched), L, y + 2);
    const nameW = ctx.measureText(labelOf(run.sched)).width;
    ctx.font = '11px ' + css('--mono'); ctx.fillStyle = css('--faint');
    const inWin = run.rows.filter(r => r.finish >= ws && r.start <= we);
    ctx.fillText(`${inWin.length} tasks in window${run.lanes.n > 1 ? ` · ${run.lanes.n} lanes` : ''}`, L + nameW + 12, y + 4);
    const top = y + 20, fy = top + 7, by = top + 14, bh = laneH * run.lanes.n;
    // track bg + grid
    ctx.fillStyle = css('--panel2'); roundRect(ctx, L, top, pw, 14 + bh + 4, 8); ctx.fill();
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    gridTicks.forEach(t => { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 18 + bh); ctx.stroke(); });
    // bars
    inWin.forEach(r => {
      if (r.mode === 'failed') {
        const x = X(r.start), k = 3.5; ctx.strokeStyle = css('--failed'); ctx.lineWidth = 1.8; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - k, fy - k); ctx.lineTo(x + k, fy + k); ctx.moveTo(x + k, fy - k); ctx.lineTo(x - k, fy + k); ctx.stroke();
        gantt.hits.push({ x: x - 5, y: fy - 6, w: 10, h: 12, r, run });
        return;
      }
      const lane = run.lanes.of.get(r.id), x0 = Math.max(L, X(r.start)), x1 = Math.min(L + pw, X(r.finish));
      let bw = x1 - x0; if (bw > 4) bw -= 2; bw = Math.max(1.5, bw);
      const yy = by + lane * laneH + (laneH > 8 ? 1 : 0), hh = laneH > 8 ? laneH - 2 : laneH - 1;
      ctx.fillStyle = css(r.mode === 'offload' ? '--offload' : '--local');
      roundRect(ctx, x0, yy, bw, hh, Math.min(4, hh / 2)); ctx.fill();
      if (gantt.hover && gantt.hover.r === r) { ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.5; ctx.stroke(); }
      if (laneH >= 10) {
        ctx.fillStyle = css('--panel');
        if (r.finish > we) chevron(ctx, L + pw - 6, yy + hh / 2, 1);
        if (r.start < ws) chevron(ctx, L + 6, yy + hh / 2, -1);
      }
      gantt.hits.push({ x: x0, y: yy, w: bw, h: hh, r, run });
    });
    if (gantt.hover && gantt.hover.run === run && gantt.hover.r.dl >= ws && gantt.hover.r.dl <= we) {
      const x = Math.round(X(gantt.hover.r.dl)) + 0.5; ctx.strokeStyle = css('--text'); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 18 + bh); ctx.stroke(); ctx.setLineDash([]);
    }
    if (run.end >= ws && run.end <= we && run.end < S.Tmax) {
      const x = X(run.end); ctx.fillStyle = css('--faint'); ctx.textAlign = 'left'; ctx.fillText('◂ last task ends', Math.min(x + 4, L + pw - 100), by + bh / 2 - 5);
    }
    y += h;
  });
  // axis
  ctx.fillStyle = css('--faint'); ctx.textBaseline = 'top';
  gridTicks.forEach(t => { ctx.textAlign = 'center'; ctx.fillText(Math.round(t) + 's', Math.min(Math.max(X(t), L + 16), L + pw - 18), y + 2); });
  // replay playhead
  if (S.T < S.Tmax && S.T >= ws && S.T <= we) {
    const x = Math.round(X(S.T)) + 0.5; ctx.strokeStyle = css('--lime'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, y); ctx.stroke();
  }
  cv.setAttribute('aria-label', `Execution timeline from ${secs(ws)} to ${secs(we)} for ResQ-OS and ${labelOf(S.B.sched)}.`);
  drawOverview();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function chevron(ctx, x, y, dir) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.6; ctx.beginPath();
  ctx.moveTo(x - 2 * dir, y - 3); ctx.lineTo(x + 1 * dir, y); ctx.lineTo(x - 2 * dir, y + 3); ctx.stroke(); ctx.restore();
}
$('ganttCv').addEventListener('pointermove', e => {
  const rc = $('ganttCv').getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
  const hit = gantt.hits.find(h => x >= h.x - 1 && x <= h.x + h.w + 1 && y >= h.y - 1 && y <= h.y + h.h + 1);
  if ((hit && hit.r) !== (gantt.hover && gantt.hover.r)) { gantt.hover = hit || null; drawGantt(); }
  hit ? showTip(e, taskTip(hit.r, hit.run)) : hideTip();
});
$('ganttCv').addEventListener('pointerleave', () => { gantt.hover = null; hideTip(); drawGantt(); });

const ov = { drag: null };
function drawOverview() {
  const cv = $('ovCv'), { ctx, w, h } = fit(cv, 54), L = 8, pw = w - 16, Tm = S.Tmax, X = t => L + pw * t / Tm;
  ctx.fillStyle = css('--panel2'); roundRect(ctx, L, 2, pw, h - 4, 8); ctx.fill();
  [[S.A, 10], [S.B, 30]].forEach(([run, y]) => {
    ctx.fillStyle = css(run.sched === RESQ ? '--lime' : '--base'); ctx.fillRect(L + 4, y + 3, 3, 8);
    run.rows.forEach(r => {
      if (r.mode === 'failed') { ctx.fillStyle = css('--failed'); ctx.fillRect(X(r.start) - 0.5, y, 1.5, 14); return; }
      ctx.fillStyle = css(r.mode === 'offload' ? '--offload' : '--local');
      ctx.fillRect(X(r.start), y + 2, Math.max(1, X(r.finish) - X(r.start)), 10);
    });
  });
  const x0 = X(S.win.start), x1 = X(S.win.start + effSpan());
  ctx.fillStyle = css('--lime-soft'); ctx.fillRect(x0, 2, x1 - x0, h - 4);
  ctx.strokeStyle = css('--lime'); ctx.lineWidth = 2; roundRect(ctx, x0, 3, Math.max(4, x1 - x0), h - 6, 5); ctx.stroke();
  ov.geo = { L, pw, Tm };
}
$('ovCv').addEventListener('pointerdown', e => {
  if (!ov.geo) return;
  const rc = $('ovCv').getBoundingClientRect(), t = (e.clientX - rc.left - ov.geo.L) / ov.geo.pw * ov.geo.Tm;
  const inside = t >= S.win.start && t <= S.win.start + effSpan();
  ov.drag = inside ? t - S.win.start : effSpan() / 2;
  $('ovCv').setPointerCapture(e.pointerId);
  setWin(t - ov.drag);
});
$('ovCv').addEventListener('pointermove', e => {
  if (ov.drag == null) return;
  const rc = $('ovCv').getBoundingClientRect(), t = (e.clientX - rc.left - ov.geo.L) / ov.geo.pw * ov.geo.Tm;
  setWin(t - ov.drag);
});
['pointerup', 'pointercancel'].forEach(ev => $('ovCv').addEventListener(ev, () => { ov.drag = null; }));

function drawAll() { drawLive(); } // gauges and bars use CSS variables; only canvases need a redraw

/* ---------------- copy / export ---------------- */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2200); }
function resultsMarkdown(tableOnly) {
  const info = S.A.info, all = [S.A, ...S.all];
  const head = '| Scheduler | Battery policy | Completion % | Deadline miss % (of completed) | Avg turnaround s | Overall on-time % | Offload | Local | Failed | Last finish s |\n|---|---|---|---|---|---|---|---|---|---|\n';
  const body = all.map(r => `| ${labelOf(r.sched)}${r.sched === 'RoundRobin' ? ' (q=2s)' : ''} | ${r.sched === RESQ ? 'Reserve-aware' : 'Greedy'} | ${f1(r.m.completion)} | ${f1(r.m.missRate)} | ${f1(r.m.avgResp)} | ${f1(r.m.onTime)} | ${r.offload} | ${r.local} | ${r.failed} | ${Math.round(r.end)} |`).join('\n');
  if (tableOnly) return head + body;
  const v = $('verdict').textContent;
  return `## ResQ-OS: ${scenLabel(S.scn)} mission (${info.n} tasks, ${f1(info.util)}% utilization)\n\n` +
    `Battery budget: ${kJ(info.budget)} (${Math.round(BUDGET_FRACTION * 100)}% of all-offload energy ${kJ(info.allOffload)}), no recharge. ` +
    `ResQ-OS: urgency = ${W_PERIOD}·inv_norm(Period) + ${W_SLACK}·inv_norm(Slack), reserve-aware battery policy. Baselines: standard ordering, greedy battery policy.\n\n` +
    head + body + `\n\nHead to head vs ${labelOf(S.base)}: ${v}\n\nDeadline miss and avg turnaround time (finish − arrival) are over completed tasks only. Overall on-time = completion × (1 − miss/100).\n`;
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(what + ' copied to clipboard'); }
  catch (e) {
    $('dlgT').textContent = 'Copy ' + what.toLowerCase();
    $('dlgMsg').textContent = 'Your browser blocked clipboard access here. The text is selected below: press Ctrl/Cmd + C.';
    $('dlgBody').innerHTML = '<textarea readonly></textarea>';
    const ta = $('dlgBody').querySelector('textarea'); ta.value = text;
    openDlg(); ta.focus(); ta.select();
  }
}
async function copyCanvas(id) {
  const cv = $(id), name = id === 'batCv' ? 'Battery chart' : 'Timeline';
  try {
    cssEl = cv;
    const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
    const octx = out.getContext('2d'); octx.fillStyle = css('--png-bg'); octx.fillRect(0, 0, out.width, out.height); octx.drawImage(cv, 0, 0);
    const blob = await new Promise((res, rej) => out.toBlob(b => (b ? res(b) : rej(new Error('no blob'))), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(name + ' PNG copied to clipboard');
  } catch (e) {
    $('dlgT').textContent = name + ' as PNG';
    $('dlgMsg').textContent = 'Clipboard images are blocked here. Right-click (or long-press) the image to copy or save it.';
    $('dlgBody').innerHTML = `<img alt="${name} for ${scenLabel(S.scn)} mission, ResQ-OS vs ${esc(labelOf(S.base))}" src="${(() => { const o = document.createElement('canvas'); o.width = cv.width; o.height = cv.height; const c = o.getContext('2d'); cssEl = cv; c.fillStyle = css('--png-bg'); c.fillRect(0, 0, o.width, o.height); c.drawImage(cv, 0, 0); return o.toDataURL('image/png'); })()}">`;
    openDlg();
  }
}
function openDlg() { const d = $('copyDlg'); try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
$('dlgClose').addEventListener('click', () => $('copyDlg').close());
$('copyAll').addEventListener('click', () => copyText(resultsMarkdown(false), 'Results'));
$('copyTbl').addEventListener('click', () => copyText(resultsMarkdown(true), 'Table'));
document.querySelectorAll('[data-png]').forEach(b => b.addEventListener('click', () => copyCanvas(b.dataset.png)));

/* ---------------- nav highlight & resize ---------------- */
const navLinks = [...document.querySelectorAll('.tabs a')];
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(es => es.forEach(en => {
    if (en.isIntersecting) navLinks.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id));
  }), { rootMargin: '-40% 0px -55% 0px' });
  ['mission', 'board', 'compare', 'timeline', 'method'].forEach(id => io.observe($(id)));
}
let rzT = 0;
const ro = new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(() => S.A && drawLive(), 60); });
ro.observe(document.querySelector('main'));

/* ---------------- boot: open in a complete state ---------------- */
runMission(S.scn, S.base, false);
// Canvas text uses the web fonts; redraw once they arrive.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawLive());
window.__resqos = { compute, S }; // for automated checks
})();
