// Regression test: runs the UNCHANGED scheduler_engine.js on task_data.json
// and checks the reference numbers from BRIEF.md section 3.
// Also checks that the engine inlined in resqos_console.html is a byte-for-byte copy.
// Usage: node tests/regression.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(root, 'scheduler_engine.js'), 'utf8');
let inlined = null;
const htmlPath = path.join(root, 'resqos_console.html');
if (fs.existsSync(htmlPath)) {
  const m = fs.readFileSync(htmlPath, 'utf8').match(/<!-- ENGINE START[^>]*-->\n<script>\n([\s\S]*?)\n<\/script>\n<!-- ENGINE END -->/);
  inlined = m ? m[1] : '';
}
const ctx = {};
vm.createContext(ctx);
// Run the copy that ships in the HTML when it exists, so the numbers are tested on what users see.
vm.runInContext((inlined || engineSrc) +
  '\n;this.E={prepTasks,sortKeyFor,runSimulation,getResult,metrics,BUDGET_FRACTION};', ctx);
const E = ctx.E;
const data = JSON.parse(fs.readFileSync(path.join(root, 'task_data.json'), 'utf8'));

function run(scn, name) {
  const tasks = E.prepTasks(data[scn]);
  const budget = E.BUDGET_FRACTION * tasks.reduce((s, t) => s + t.oe, 0);
  return name === 'ResQ-OS'
    ? E.runSimulation(tasks, E.sortKeyFor('ResQ-OS'), 'reserve_aware', budget)
    : E.getResult(name, tasks, 'naive', budget);
}
const f = v => v.toFixed(1);
const expected = [
  ['scenario_1', 'FCFS', '56.8 / 41.8 / 101.1 / 33.1'],
  ['scenario_1', 'ResQ-OS', '100.0 / 63.6 / 474.8 / 36.4'],
  ['scenario_3', 'FCFS', '40.4 / 96.0 / 112.0 / 1.6'],
  ['scenario_3', 'EDF', '40.4 / 95.3 / 111.5 / 1.9'],
  ['scenario_3', 'Priority_RMS', '37.5 / 27.3 / 45.6 / 27.2'],
  ['scenario_3', 'ResQ-OS', '100.0 / 73.6 / 2235.9 / 26.4'],
];
let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} got ${got}${ok ? '' : `  expected ${want}`}`);
};
if (inlined !== null) check('HTML engine == scheduler_engine.js', String(inlined === engineSrc), 'true');
else console.log('SKIP  resqos_console.html not built yet (run node build.js)');
for (const [scn, name, want] of expected) {
  const m = E.metrics(run(scn, name));
  check(`${scn} ${name}`, [m.completion, m.missRate, m.avgResp, m.onTime].map(f).join(' / '), want);
}
const counts = r => ['offload', 'local_fallback', 'failed'].map(k => r.filter(x => x.mode === k).length).join('/');
check('scenario_3 ResQ-OS counts', counts(run('scenario_3', 'ResQ-OS')), '122/249/0');
check('scenario_3 FCFS counts', counts(run('scenario_3', 'FCFS')), '130/20/221');
// Every scheduler on every scenario must run and return one row per task.
for (const scn of Object.keys(data)) for (const n of ['ResQ-OS', 'FCFS', 'SJF', 'EDF', 'Priority_RMS', 'SRT', 'RoundRobin']) {
  const r = run(scn, n);
  check(`${scn} ${n} rows`, String(r.length), String(data[scn].length));
}
console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
