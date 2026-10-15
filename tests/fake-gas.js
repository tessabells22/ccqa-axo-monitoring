/**
 * In-memory stand-ins for the Apps Script services the tracker uses, so the real
 * .gs files can run under Node. Only the methods the tracker calls are implemented.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(this.sheet.get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValues(v) {
    if (v.length !== this.nr || v.some((l) => l.length !== this.nc)) throw new Error('setValues dimension mismatch');
    v.forEach((line, r) => line.forEach((val, c) => this.sheet.set(this.row + r, this.col + c, val)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  // Real Sheets writes FALSE into every cell that gets a checkbox.
  insertCheckboxes() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) {
      const cur = this.sheet.get(this.row + r, this.col + c);
      if (cur === '' || cur == null) this.sheet.set(this.row + r, this.col + c, false);
    }
    return this;
  }
  getColumn() { return this.col; }
  createFilter() { this.sheet.filter = true; return this; }
}
['setFontWeight', 'setBackground', 'setFontColor', 'setDataValidation', 'setNumberFormat', 'setWrap'].forEach((m) => {
  FakeRange.prototype[m] = function () { return this; };
});

class FakeSheet {
  constructor(name) { this.name = name; this.cells = new Map(); this.maxRows = 1000; this.cf = []; this.filter = null; }
  key(r, c) { return r + ':' + c; }
  get(r, c) { const v = this.cells.get(this.key(r, c)); return v === undefined ? '' : v; }
  set(r, c, v) {
    if (v === '' || v == null) this.cells.delete(this.key(r, c)); else this.cells.set(this.key(r, c), v);
    if (r > this.maxRows) this.maxRows = r;
  }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, +k.split(':')[0]); return m; }
  getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, +k.split(':')[1]); return m; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, i) => this.set(r, i + 1, v)); return this; }
  setFrozenRows() {} setFrozenColumns() {} setColumnWidth() {}
  getConditionalFormatRules() { return this.cf; }
  setConditionalFormatRules(r) { this.cf = r; }
  getFilter() { return this.filter; }
  dump() {
    const out = [];
    for (let r = 1; r <= this.getLastRow(); r++) out.push(this.getRange(r, 1, 1, this.getLastColumn()).getValues()[0]);
    return out;
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake'; }
}

function chain() {
  const p = new Proxy({}, { get: (t, k) => (k === 'build' ? () => ({ ranges: t.ranges || [], getRanges: () => t.ranges || [] }) :
    (...a) => { if (k === 'setRanges') t.ranges = a[0]; return p; }) });
  return p;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function formatDate(d, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short'
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
  return pattern
    .replace(/'T'/, '\u0001')
    .replace('yyyy', parts.year).replace('MMM', '\u0002').replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
    .replace('EEE', parts.weekday).replace(/\bd\b/, String(+parts.day))
    .replace('\u0002', mon).replace('\u0001', 'T');
}

function loadGas(opts = {}) {
  const ss = new FakeSpreadsheet();
  const props = Object.assign({}, opts.props || {});
  const slackPosts = [];
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss,
      newDataValidation: chain, newConditionalFormatRule: chain,
      getUi: () => ({ createMenu: () => chain() })
    },
    Session: { getScriptTimeZone: () => 'Asia/Manila', getActiveUser: () => ({ getEmail: () => opts.email || '' }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    UrlFetchApp: { fetch: (url, o) => { slackPosts.push(JSON.parse(o.payload)); return { getResponseCode: () => 200, getContentText: () => 'ok' }; } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/fake/exec' }),
      getProjectTriggers: () => [], WeekDay: {}, newTrigger: () => chain() },
    HtmlService: {}
  };
  vm.createContext(ctx);
  const src = path.join(__dirname, '..', 'src');
  ['Mapping.gs', 'Code.gs', 'Slack.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), ctx, { filename: f }));
  return { ctx, ss, props, slackPosts };
}

module.exports = { loadGas };
