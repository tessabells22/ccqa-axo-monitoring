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

const gas = loadGas({ email: 'preview@example.com' });
gas.ctx.setup();
gas.ctx.importCsv(fs.readFileSync(csvPath, 'utf8'), 'Preview');

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
        if (!/^(getBootstrap|updateItem|addItem|importCsv|getItemDetail|addNote)$/.test(fn)) throw new Error('Not exposed: ' + fn);
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
