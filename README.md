# ResQ-OS Mission Console

**Live demo:** https://ashwika05-star.github.io/resqos-mission-console/

Open **`resqos_console.html`** in any browser. It is one self-contained file: the task data and the
unmodified `scheduler_engine.js` are inlined, and the only network requests are for Google Fonts.

Direct links for screenshots: `resqos_console.html#heavy-FCFS`, `#light-Priority_RMS`, `#medium-SJF`, and so on.
The baseline keys are FCFS, SJF, EDF, Priority_RMS, SRT and RoundRobin.

## Files

| Path | Role |
|---|---|
| `resqos_console.html`, `index.html` | Built output (identical; `index.html` is what GitHub Pages serves). Do not edit by hand. |
| `src/console.template.html` | Page layout and styles |
| `src/app.js` | UI logic. It only reads engine output and contains no scheduling logic. |
| `scheduler_engine.js` | Simulation engine, copied verbatim into the page |
| `task_data.json` | 3D-UAV-MEC tasks (three scenarios) |
| `build.js` | Inlines data, engine and app into the template |
| `tests/regression.test.js` | Checks the BRIEF section 3 reference numbers and that the inlined engine is byte-identical |

## Build and test

```bash
node build.js && node tests/regression.test.js
```
