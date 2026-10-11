// Builds the single self-contained console: resqos_console.html
// Inlines task_data.json, scheduler_engine.js (verbatim) and src/app.js into src/console.template.html.
// Usage: node build.js
const fs = require('fs');
const path = require('path');
const r = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const data = JSON.stringify(JSON.parse(r('task_data.json')));
const engine = r('scheduler_engine.js');
const app = r('src/app.js');
for (const [n, s] of [['data', data], ['engine', engine], ['app', app]]) {
  if (/<\/script/i.test(s)) throw new Error(n + ' contains </script>');
}
// Use function replacers so "$" sequences in the sources are never interpreted.
const html = r('src/console.template.html')
  .replace('/*__DATA__*/', () => data)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__APP__*/', () => app);
fs.writeFileSync(path.join(__dirname, 'resqos_console.html'), html);
console.log('wrote resqos_console.html', (html.length / 1024).toFixed(0) + ' KB');
// GitHub Pages serves index.html at the site root.
fs.writeFileSync(path.join(__dirname, 'index.html'), html);

// Hosted-artifact copy: the host supplies <!doctype>, <html>, <head>, <body>, charset and viewport,
// so strip those and start the file with <title>. Everything else is identical.
const pub = html
  .replace(/^<!doctype html>\n<html[^>]*>\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^>]*>\n/, '')
  .replace('</head>\n<body>\n', '')
  .replace(/<\/body>\n<\/html>\n?$/, '');
if (!pub.startsWith('<title>') || /<\/?(html|head|body)[\s>]/.test(pub)) throw new Error('publish strip failed');
fs.mkdirSync(path.join(__dirname, 'publish'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'publish', 'resqos_console.html'), pub);
console.log('wrote publish/resqos_console.html');
