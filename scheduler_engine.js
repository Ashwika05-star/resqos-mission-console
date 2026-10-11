
const SCENARIO_UTIL = { scenario_1: 38.0, scenario_2: 79.0, scenario_3: 119.8 };
const BUDGET_FRACTION = 0.35;
const W_PERIOD = 0.7, W_SLACK = 0.3;

function prepTasks(raw) {
  const tasks = raw.map(t => ({...t}));
  const periods = tasks.map(t => t.per);
  const minP = Math.min(...periods), maxP = Math.max(...periods);
  tasks.forEach(t => { t.slack = t.dl - t.arr - t.exec; });
  const slacks = tasks.map(t => t.slack);
  const minS = Math.min(...slacks), maxS = Math.max(...slacks);
  const invP = tasks.map(t => 1 / t.per);
  const minInvP = Math.min(...invP), maxInvP = Math.max(...invP);
  const invS = tasks.map(t => 1 / t.slack);
  const minInvS = Math.min(...invS), maxInvS = Math.max(...invS);
  tasks.forEach((t, i) => {
    const normP = (invP[i] - minInvP) / (maxInvP - minInvP);
    const normS = (invS[i] - minInvS) / (maxInvS - minInvS);
    t.urgency = W_PERIOD * normP + W_SLACK * normS;
  });
  return tasks;
}

function sortKeyFor(name) {
  return {
    FCFS: t => t.arr,
    SJF: t => t.exec,
    EDF: t => t.dl,
    Priority_RMS: t => t.per,
    "ResQ-OS": t => -t.urgency,
  }[name];
}

function runSimulation(tasks, sortKey, batteryMode, budget) {
  let pending = [...tasks].sort((a,b) => a.arr - b.arr);
  let ready = [];
  let results = [];
  let currentTime = 0, battery = budget;
  let remainingLocalTotal = tasks.reduce((s,t) => s + t.le, 0);

  while (pending.length || ready.length) {
    const arrived = pending.filter(t => t.arr <= currentTime);
    if (arrived.length) {
      ready.push(...arrived);
      pending = pending.filter(t => t.arr > currentTime);
    }
    if (!ready.length) { currentTime = Math.min(...pending.map(t => t.arr)); continue; }

    ready.sort((a,b) => sortKey(a) - sortKey(b));
    const task = ready.shift();
    remainingLocalTotal -= task.le;

    let canOffload = batteryMode === 'naive' ? battery >= task.oe : (battery - task.oe) >= remainingLocalTotal;
    let mode, cost, duration;
    if (canOffload) { mode='offload'; cost=task.oe; duration=task.ot; }
    else if (battery >= task.le) { mode='local_fallback'; cost=task.le; duration=task.exec; }
    else { mode='failed'; cost=0; duration=0; }

    battery -= cost;
    const start = currentTime;
    const finish = mode !== 'failed' ? start + duration : start;
    const met = mode !== 'failed' && finish <= task.dl;
    results.push({id: task.id, mode, start, finish, met, resp: finish - task.arr});
    if (mode !== 'failed') currentTime = finish;
  }
  return results;
}

function runSRT(tasks, batteryMode, budget) {
  let pending = [...tasks].sort((a,b) => a.arr - b.arr);
  let ready = [], pool = [], results = [];
  let currentTime = 0, battery = budget;
  let remainingLocalTotal = tasks.reduce((s,t) => s + t.le, 0);

  while (pending.length || ready.length || pool.length) {
    const arrived = pending.filter(t => t.arr <= currentTime);
    if (arrived.length) { ready.push(...arrived); pending = pending.filter(t => t.arr > currentTime); }
    if (!ready.length && !pool.length) { currentTime = Math.min(...pending.map(t => t.arr)); continue; }

    const candidates = [
      ...ready.map(t => ({key: t.exec, kind: 'ready', t})),
      ...pool.map(t => ({key: t._rem, kind: 'pool', t})),
    ].sort((a,b) => a.key - b.key);
    const c = candidates[0];

    if (c.kind === 'ready') {
      ready = ready.filter(x => x !== c.t);
      remainingLocalTotal -= c.t.le;
      let canOffload = batteryMode === 'naive' ? battery >= c.t.oe : (battery - c.t.oe) >= remainingLocalTotal;
      if (canOffload) {
        battery -= c.t.oe;
        const finish = currentTime + c.t.ot;
        results.push({id: c.t.id, mode:'offload', start: currentTime, finish, met: finish <= c.t.dl, resp: finish - c.t.arr});
        currentTime = finish;
      } else if (battery >= c.t.le) {
        battery -= c.t.le;
        c.t._rem = c.t.exec; c.t._start = currentTime;
        pool.push(c.t);
      } else {
        results.push({id: c.t.id, mode:'failed', start: currentTime, finish: currentTime, met: false, resp: 0});
      }
    } else {
      c.t._rem -= 1; currentTime += 1;
      if (c.t._rem <= 0) {
        pool = pool.filter(x => x !== c.t);
        results.push({id: c.t.id, mode:'local_fallback', start: c.t._start, finish: currentTime, met: currentTime <= c.t.dl, resp: currentTime - c.t.arr});
      }
    }
  }
  return results;
}

function runRR(tasks, batteryMode, budget, quantum=2) {
  let pending = [...tasks].sort((a,b) => a.arr - b.arr);
  let q = [], results = [];
  let currentTime = 0, battery = budget;
  let remainingLocalTotal = tasks.reduce((s,t) => s + t.le, 0);

  while (pending.length || q.length) {
    const arrived = pending.filter(t => t.arr <= currentTime);
    if (arrived.length) { q.push(...arrived); pending = pending.filter(t => t.arr > currentTime); }
    if (!q.length) { currentTime = Math.min(...pending.map(t => t.arr)); continue; }

    const task = q.shift();
    if (task._mode === undefined) {
      remainingLocalTotal -= task.le;
      let canOffload = batteryMode === 'naive' ? battery >= task.oe : (battery - task.oe) >= remainingLocalTotal;
      if (canOffload) {
        task._mode = 'offload'; battery -= task.oe;
        const finish = currentTime + task.ot;
        results.push({id: task.id, mode:'offload', start: currentTime, finish, met: finish <= task.dl, resp: finish - task.arr});
        currentTime = finish; continue;
      } else if (battery >= task.le) {
        task._mode = 'local_fallback'; battery -= task.le;
        task._rem = task.exec; task._start = currentTime;
      } else {
        results.push({id: task.id, mode:'failed', start: currentTime, finish: currentTime, met: false, resp: 0});
        continue;
      }
    }
    const run = Math.min(quantum, task._rem);
    task._rem -= run; currentTime += run;
    if (task._rem <= 1e-9) {
      results.push({id: task.id, mode: task._mode, start: task._start, finish: currentTime, met: currentTime <= task.dl, resp: currentTime - task.arr});
    } else {
      const arrived2 = pending.filter(t => t.arr <= currentTime);
      if (arrived2.length) { q.push(...arrived2); pending = pending.filter(t => t.arr > currentTime); }
      q.push(task);
    }
  }
  return results;
}

function getResult(name, tasks, batteryMode, budget) {
  if (name === 'SRT') return runSRT(tasks, batteryMode, budget);
  if (name === 'RoundRobin') return runRR(tasks, batteryMode, budget);
  return runSimulation(tasks, sortKeyFor(name), batteryMode, budget);
}

function metrics(results) {
  const completed = results.filter(r => r.mode !== 'failed');
  const n = results.length;
  const completion = 100 * completed.length / n;
  const missRate = completed.length ? 100 * (1 - completed.filter(r=>r.met).length/completed.length) : NaN;
  const avgResp = completed.length ? completed.reduce((s,r)=>s+r.resp,0)/completed.length : NaN;
  const onTime = completion * (1 - missRate/100);
  return { completion, missRate, avgResp, onTime };
}

function fmt(v, suf='') { return isNaN(v) ? '—' : v.toFixed(1) + suf; }
