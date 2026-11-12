/**
 * Local preview: serves the web app with google.script.run wired to the real .gs
 * code running on an in-memory sheet. Nothing is saved between runs.
 *
 *   node tools/preview-server.js [path/to/axo-export.csv] [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../tests/fake-gas');

const csvPath = process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'axo-items-sample.csv');
const port = Number(process.argv[3] || 8787);
const src = path.join(__dirname, '..', 'src');

// PREVIEW_SLACK=1 pretends Slack is configured (messages are captured, not sent).
// PREVIEW_DEMO=1 spreads the AXOs over handlers and statuses so every screen has data.
const gas = loadGas({ email: 'preview@example.com', props: Object.assign({ DELETE_PASSCODE: 'preview' }, process.env.PREVIEW_SLACK
  ? { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/preview', SLACK_BOT_TOKEN: 'xoxb-preview' } : {}) });
gas.ctx.setup();
if (process.env.PREVIEW_DEMO) gas.setNow(Date.now() - 9 * 864e5);
gas.ctx.importCsv(fs.readFileSync(csvPath, 'utf8'), 'Preview');
const lists = gas.ss.getSheetByName('Lists');
const head = lists.dump()[0];
const col = (h) => head.indexOf(h) + 1;
lists.set(2, col('Email To'), 'lead.one@example.com');
lists.set(3, col('Email To'), 'lead.two@example.com');
lists.set(2, col('Email CC'), 'qa-team@example.com');
if (process.env.PREVIEW_SLACK) {
  for (let r = 2; r <= lists.getLastRow(); r++) {
    if (lists.get(r, col('Handler'))) lists.set(r, col('Handler Slack ID'), 'U' + r);
  }
}
if (process.env.PREVIEW_DEMO) {
  const handlers = ['Ley - QA', 'Carla - QA', 'Tessa - QA', 'Joanne - QA', 'AJ - QA', 'Liza - QA'];
  const statuses = ['Ongoing QA', 'Done', 'For Review', 'Done', 'Awaiting BA/DEV', 'For Upload', 'Done', 'Review Points', 'Ongoing BA/DEV', 'Moved', '', ''];
  gas.ctx.getBootstrap().items.forEach((item, n) => {
    gas.setNow(Date.now() - (8 - (n % 8)) * 864e5);
    const status = statuses[n % statuses.length];
    if (n % 7 !== 6) gas.ctx.updateItem(item.id, { handler: handlers[(n * 5) % handlers.length], system: 'DEV 800' }, 'Preview');
    if (status === 'Review Points') gas.ctx.setReviewPoints(item.id, 'TC3 screenshot is missing the rate response.', handlers[(n + 1) % handlers.length]);
    else if (status) gas.ctx.updateItem(item.id, { status }, 'Preview');
    if (n % 9 === 4) gas.ctx.addNote(item.id, 'Blocker', 'Carrier credentials expired in DEV 800; raised with BA.', handlers[n % handlers.length]);
  });
  gas.setNow(null);
}

const shim = `<script>
window.google = { script: {
  url: { getLocation: function (cb) { var p = {}; new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; }); cb({ parameter: p }); } },
  get run() {
    var ok = function () {}, fail = function () {};
    var proxy = new Proxy({}, { get: function (_, fn) {
      if (fn === 'withSuccessHandler') return function (f) { ok = f; return proxy; };
      if (fn === 'withFailureHandler') return function (f) { fail = f; return proxy; };
      return function () {
        fetch('/rpc/' + fn, { method: 'POST', body: JSON.stringify([].slice.call(arguments)) })
          .then(function (r) { return r.json(); })
          .then(function (j) { j.error ? fail(new Error(j.error)) : ok(j.result); }, fail);
      };
    } });
    return proxy;
  }
} };
</script>`;

function page() {
  let html = fs.readFileSync(path.join(src, 'Index.html'), 'utf8');
  html = html.replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => fs.readFileSync(path.join(src, n + '.html'), 'utf8'));
  return html.replace('<head>', '<head>' + shim);
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/rpc/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const fn = req.url.slice(5);
      let out;
      try {
        if (!/^(getBootstrap|updateItem|addItem|importCsv|getItemDetail|addNote|setReviewPoints|deleteItems|buildReport|reportPdf|updateItems)$/.test(fn)) throw new Error('Not exposed: ' + fn);
        out = { result: JSON.parse(JSON.stringify(gas.ctx[fn](...JSON.parse(body)))) };
      } catch (e) { out = { error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page());
}).listen(port, () => console.log('Preview on http://localhost:' + port));
