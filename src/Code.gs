/**
 * CCQA AXO Monitoring Tracker: Apps Script web app over a Google Sheet.
 *
 * Sheets (created by setup()):
 *   Items     one row per AXO item; CSV columns + QA tracking columns
 *   Notes     append-only team notes, one row per note
 *   Activity  audit trail of every field change and import
 *   Lists     dropdown values (handlers, systems, categories), Slack IDs and email recipients
 *   Deleted   AXOs removed from the tracker, kept so they can be restored
 */

var SHEETS = { items: 'Items', notes: 'Notes', activity: 'Activity', lists: 'Lists', deleted: 'Deleted' };
/** Bump when setup() must run again on an existing sheet (new columns or tabs). */
var SCHEMA_VERSION = '3';
var LIST_EXTRA_COLUMNS = ['Handler Slack ID', 'Email To', 'Email CC'];
var TZ = Session.getScriptTimeZone() || 'Asia/Manila';

// ---------------------------------------------------------------- web app

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CCQA AXO Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Adds a "CCQA Tracker" menu to the bound spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('CCQA Tracker')
    .addItem('Set up / repair sheets', 'setup')
    .addItem('Restore selected rows (Deleted tab)', 'restoreSelectedDeleted')
    .addSeparator()
    .addItem('Check Slack setup', 'checkSlackSetupMenu')
    .addItem('Send Slack test message', 'testSlack')
    .addItem('Send weekly digest now', 'sendWeeklyDigest')
    .addItem('Send 2-day nudges now', 'sendNudges')
    .addItem('Install schedules (digest + nudges)', 'installTriggers')
    .addToUi();
}

// ---------------------------------------------------------------- setup

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() from the Apps Script editor first.');
  return sh;
}

/** Creates or repairs every sheet, header, dropdown and colour rule. Safe to re-run. */
function setup() {
  var ss = ss_();
  var items = ensureSheet_(ss, SHEETS.items, ITEM_COLUMNS.map(function (c) { return c.header; }));
  ensureSheet_(ss, SHEETS.notes, NOTE_COLUMNS);
  ensureSheet_(ss, SHEETS.activity, ACTIVITY_COLUMNS);
  ensureSheet_(ss, SHEETS.deleted, deletedColumns_());
  var lists = ss.getSheetByName(SHEETS.lists);
  if (!lists) {
    lists = ss.insertSheet(SHEETS.lists);
    var names = Object.keys(DEFAULT_LISTS);
    lists.getRange(1, 1, 1, names.length).setValues([names]).setFontWeight('bold');
    names.forEach(function (n, i) {
      var vals = DEFAULT_LISTS[n] || [];
      if (vals.length) lists.getRange(2, i + 1, vals.length, 1).setValues(vals.map(function (v) { return [v]; }));
    });
    lists.setFrozenRows(1);
  }
  // Columns added in later versions go to the right of whatever the team already has.
  var head = lists.getRange(1, 1, 1, Math.max(lists.getLastColumn(), 1)).getValues()[0];
  LIST_EXTRA_COLUMNS.forEach(function (h) {
    if (head.indexOf(h) >= 0) return;
    head.push(h);
    lists.getRange(1, head.length).setValue(h).setFontWeight('bold');
  });
  formatItems_(items);
  backfillStatusSince_(items);
  PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
  console.log('Setup complete');
  return 'Setup complete';
}

/** Runs setup() once after an update that changed the sheet layout, so nobody has to remember to. */
function ensureSchema_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === SCHEMA_VERSION) return;
  withLock_(function () {
    if (props.getProperty('SCHEMA_VERSION') !== SCHEMA_VERSION) setup();
  });
}

function deletedColumns_() {
  return ITEM_COLUMNS.map(function (c) { return c.header; }).concat(['Deleted By', 'Deleted At']);
}

/**
 * Rows from before "Status Since" existed get the time of their last Status change
 * from the Activity log, or else their last update.
 */
function backfillStatusSince_(sh) {
  var data = readItems_();
  var col = colIndex_();
  var missing = data.rows.filter(function (r) { return !r.values[col.statusSince]; });
  if (!missing.length) return;
  var lastChange = {}, hpEdited = {};
  var ash = sheet_(SHEETS.activity);
  if (ash.getLastRow() > 1) {
    ash.getRange(2, 1, ash.getLastRow() - 1, ACTIVITY_COLUMNS.length).getValues().forEach(function (r) {
      if (String(r[3]) === 'Status' && r[0]) lastChange[String(r[2])] = r[0];
      if (String(r[3]) === 'High Priority') hpEdited[String(r[2])] = true;
    });
  }
  var now = new Date();
  var time = function (v) { return Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : 0; };
  var latestImport = Math.max.apply(null, data.rows.map(function (r) { return time(r.values[col.lastImported]); }).concat([0]));
  missing.forEach(function (r) {
    var when = lastChange[String(r.values[0])] || r.values[col.updatedAt] || r.values[col.lastImported] || now;
    sh.getRange(r.rowNum, col.statusSince + 1).setValue(when);
    // Earlier versions unticked both checkbox columns on newly imported rows by mistake.
    // Put High Priority back for High-priority AXOs nobody has changed by hand, and
    // "In Latest Import" back for rows that were in the most recent import.
    if (r.values[col.priority] === 'High' && r.values[col.highPriority] !== true && !hpEdited[String(r.values[0])]) {
      sh.getRange(r.rowNum, col.highPriority + 1).setValue(true);
    }
    var imported = time(r.values[col.lastImported]);
    if (imported && latestImport - imported < 60000 && r.values[col.inLatestImport] !== true) {
      sh.getRange(r.rowNum, col.inLatestImport + 1).setValue(true);
    }
  });
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  headers.forEach(function (h, i) {
    if (current[i] !== h) sh.getRange(1, i + 1).setValue(h);
  });
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  return sh;
}

/** Mirrors the AXO Monitoring 2026 workbook: header colours, dropdowns, status fills. */
function formatItems_(sh) {
  var col = colIndex_();
  var width = ITEM_COLUMNS.length;
  var maxRows = Math.max(sh.getMaxRows(), 500);
  if (sh.getMaxRows() < maxRows) sh.insertRowsAfter(sh.getMaxRows(), maxRows - sh.getMaxRows());

  sh.getRange(1, 1, 1, width).setBackground('#0F6EC8').setFontColor('#FFFFFF').setFontWeight('bold');
  sh.getRange(1, col.highPriority + 1).setBackground('#FF0000');
  sh.getRange(1, col.commentDev + 1).setBackground('#00B0F0');
  sh.getRange(1, col.commentSed + 1).setBackground('#FFFF00').setFontColor('#000000');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  var widths = { id: 70, itemType: 90, name: 520, workflowStep: 170, priority: 75, developer: 170, reportedBy: 170,
    releaseNotes: 260, quarter: 90, highPriority: 95, axoCategory: 100, system: 100, handler: 120, status: 130,
    completedOn: 120, commentDev: 420, commentSed: 300, updatedBy: 150, updatedAt: 150, lastImported: 150, inLatestImport: 110,
    statusSince: 150, lastNudged: 110 };
  Object.keys(widths).forEach(function (k) { sh.setColumnWidth(col[k] + 1, widths[k]); });

  var body = function (k) { return sh.getRange(2, col[k] + 1, maxRows - 1, 1); };
  var listRule = function (header) {
    var lists = sheet_(SHEETS.lists);
    var idx = lists.getRange(1, 1, 1, lists.getLastColumn()).getValues()[0].indexOf(header);
    if (idx < 0) return null;
    return SpreadsheetApp.newDataValidation()
      .requireValueInRange(lists.getRange(2, idx + 1, 200, 1), true).setAllowInvalid(true).build();
  };
  // Checkboxes only on rows that hold data, so empty rows stay truly empty.
  checkboxes_(sh, 2, firstFreeRow_(sh) - 2);
  ['axoCategory', 'system', 'handler'].forEach(function (k) {
    var header = { axoCategory: 'AXO Category', system: 'System', handler: 'Handler' }[k];
    var rule = listRule(header);
    if (rule) body(k).setDataValidation(rule);
  });
  body('status').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES.map(function (s) { return s.name; }), true).setAllowInvalid(false).build())
    .setFontWeight('bold');
  body('quarter').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(ISBLANK(' + colLetter_(col.quarter + 1) + '2),REGEXMATCH(' + colLetter_(col.quarter + 1) + '2,"^Q[1-4] [0-9]{4}$"))')
    .setAllowInvalid(false).setHelpText('Use the form Q4 2026').build());
  body('completedOn').setNumberFormat('yyyy-mm-dd');
  body('updatedAt').setNumberFormat('yyyy-mm-dd hh:mm');
  body('lastImported').setNumberFormat('yyyy-mm-dd hh:mm');
  body('statusSince').setNumberFormat('yyyy-mm-dd hh:mm');
  body('lastNudged').setNumberFormat('yyyy-mm-dd');
  body('name').setWrap(true);
  body('commentDev').setWrap(true);
  body('commentSed').setWrap(true);

  var statusRange = body('status');
  var rules = sh.getConditionalFormatRules().filter(function (r) {
    return !r.getRanges().some(function (rg) { return rg.getColumn() === statusRange.getColumn(); });
  });
  STATUSES.forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s.name).setBackground(s.fill).setFontColor(s.ink).setRanges([statusRange]).build());
  });
  sh.setConditionalFormatRules(rules);

  if (!sh.getFilter()) sh.getRange(1, 1, maxRows, width).createFilter();
}

// ---------------------------------------------------------------- helpers

function colIndex_() {
  var out = {};
  ITEM_COLUMNS.forEach(function (c, i) { out[c.key] = i; });
  return out;
}

function colLetter_(n) {
  var s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

function currentQuarter_() {
  var now = new Date();
  return quarterLabel(Utilities.formatDate(now, TZ, 'yyyy'), Utilities.formatDate(now, TZ, 'MM'));
}

/** First row below the last non-empty ID. */
function firstFreeRow_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 2;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]).trim()) return i + 3;
  return 2;
}

/** Grows the sheet so rows up to `lastRow` exist; getRange() throws past the last row. */
function ensureRows_(sh, lastRow) {
  var max = sh.getMaxRows();
  if (lastRow > max) sh.insertRowsAfter(max, lastRow - max + 50);
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/**
 * Shows the two TRUE/FALSE columns as checkboxes. This uses a validation rule, not
 * insertCheckboxes(): that call resets every cell in the range to FALSE.
 */
function checkboxes_(sh, startRow, count) {
  if (count < 1) return;
  var col = colIndex_();
  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sh.getRange(startRow, col.highPriority + 1, count, 1).setDataValidation(rule);
  sh.getRange(startRow, col.inLatestImport + 1, count, 1).setDataValidation(rule);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function fmtDate_(v, pattern) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, pattern);
  return String(v);
}

function rowToItem_(row, today) {
  var item = {};
  ITEM_COLUMNS.forEach(function (c, i) { item[c.key] = row[i]; });
  item.id = String(item.id);
  item.highPriority = item.highPriority === true || String(item.highPriority).toUpperCase() === 'TRUE';
  item.inLatestImport = item.inLatestImport === true || String(item.inLatestImport).toUpperCase() === 'TRUE';
  item.completedOn = fmtDate_(item.completedOn, 'yyyy-MM-dd');
  item.updatedAt = fmtDate_(item.updatedAt, "yyyy-MM-dd'T'HH:mm:ss");
  item.lastImported = fmtDate_(item.lastImported, "yyyy-MM-dd'T'HH:mm:ss");
  item.statusSince = fmtDate_(item.statusSince, "yyyy-MM-dd'T'HH:mm:ss");
  item.lastNudged = fmtDate_(item.lastNudged, 'yyyy-MM-dd');
  ['itemType', 'name', 'workflowStep', 'priority', 'developer', 'reportedBy', 'releaseNotes', 'quarter', 'axoCategory',
   'system', 'handler', 'status', 'commentDev', 'commentSed', 'updatedBy'].forEach(function (k) {
    item[k] = item[k] == null ? '' : String(item[k]);
  });
  // Working days (Tue-Sat) in the current status; null once the AXO is finished or has no start time.
  item.daysInStatus = item.statusSince && FINAL_STATUSES.indexOf(item.status) < 0
    ? workingDaysBetween(item.statusSince, today || today_()) : null;
  return item;
}

function readItems_() {
  var sh = sheet_(SHEETS.items);
  var last = sh.getLastRow();
  if (last < 2) return { sheet: sh, rows: [] };
  var values = sh.getRange(2, 1, last - 1, ITEM_COLUMNS.length).getValues();
  var rows = [];
  values.forEach(function (v, i) { if (String(v[0]).trim()) rows.push({ rowNum: i + 2, values: v }); });
  return { sheet: sh, rows: rows };
}

function findRow_(id) {
  var data = readItems_();
  for (var i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i].values[0]) === String(id)) return { sheet: data.sheet, rowNum: data.rows[i].rowNum, values: data.rows[i].values };
  }
  return null;
}

/** Every change is signed: the web app sends the name picked in the top bar. */
function requireActor_(name) {
  if (!String(name == null ? '' : name).trim()) throw new Error('Pick your name in the top bar before making changes.');
}

function actor_(name) {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) {}
  name = String(name || '').trim();
  if (name && email) return name + ' <' + email + '>';
  return name || email || 'Unknown';
}

function logActivity_(entries) {
  if (!entries.length) return;
  var sh = sheet_(SHEETS.activity);
  sh.getRange(sh.getLastRow() + 1, 1, entries.length, ACTIVITY_COLUMNS.length).setValues(entries);
}

function readLists_() {
  var sh = sheet_(SHEETS.lists);
  var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  var out = {};
  if (!lastCol || lastRow < 1) return out;
  var values = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
  values[0].forEach(function (h, c) {
    if (!h) return;
    out[h] = [];
    for (var r = 1; r < values.length; r++) out[h].push(String(values[r][c] || '').trim());
  });
  var slack = {};
  (out['Handler'] || []).forEach(function (h, i) {
    var sid = (out['Handler Slack ID'] || [])[i];
    if (h && sid) slack[h] = sid;
  });
  Object.keys(out).forEach(function (k) { out[k] = out[k].filter(String); });
  out.slackIds = slack;
  return out;
}

// ---------------------------------------------------------------- API (google.script.run)

function getBootstrap() {
  ensureSchema_();
  var data = readItems_();
  var counts = {}, reviews = [];
  var notes = sheet_(SHEETS.notes);
  if (notes.getLastRow() > 1) {
    notes.getRange(2, 1, notes.getLastRow() - 1, NOTE_COLUMNS.length).getValues().forEach(function (r) {
      var id = String(r[1]);
      counts[id] = (counts[id] || 0) + 1;
      if (String(r[2]) === REVIEW_KIND) reviews.push({ id: id, by: String(r[4]).replace(/\s*<.*>$/, '') });
    });
  }
  var lists = readLists_();
  var props = PropertiesService.getScriptProperties();
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) {}
  var today = today_();
  var token = props.getProperty('SLACK_BOT_TOKEN') || '';
  return {
    items: data.rows.map(function (r) { return rowToItem_(r.values, today); }),
    noteCounts: counts,
    reviews: reviews,
    today: today,
    nudgeAfterDays: NUDGE_AFTER_DAYS,
    nudgeStatuses: NUDGE_STATUSES,
    deleteEnabled: !!props.getProperty('DELETE_PASSCODE'),
    appUrl: slackConfig_().appUrl,
    emailTo: lists['Email To'] || [],
    emailCc: lists['Email CC'] || [],
    lists: {
      categories: lists['AXO Category'] || DEFAULT_LISTS['AXO Category'],
      systems: lists['System'] || DEFAULT_LISTS['System'],
      handlers: lists['Handler'] || DEFAULT_LISTS['Handler'],
      noteKinds: lists['Note Kind'] || DEFAULT_LISTS['Note Kind'],
      slackHandlers: Object.keys(lists.slackIds || {})
    },
    currentQuarter: currentQuarter_(),
    slackDm: /^xoxb-/.test(token),
    slackTokenIssue: token && !/^xoxb-/.test(token) ? 'SLACK_BOT_TOKEN is not a bot token (it must start with xoxb-)' : '',
    statuses: STATUSES,
    email: email,
    lastImport: props.getProperty('LAST_IMPORT') || '',
    slackEnabled: !!props.getProperty('SLACK_WEBHOOK_URL'),
    sheetUrl: ss_().getUrl(),
    serverTime: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

/** Writes only the fields in `patch`, so two people editing different fields don't clobber each other. */
function updateItem(id, patch, actorName) {
  requireActor_(actorName);
  return withLock_(function () {
    var hit = findRow_(id);
    if (!hit) throw new Error('AXO ' + id + ' is no longer in the tracker.');
    var col = colIndex_();
    var who = actor_(actorName);
    var now = new Date();
    var before = rowToItem_(hit.values);
    var log = [];
    var changes = {};

    Object.keys(patch || {}).forEach(function (k) {
      var def = ITEM_COLUMNS[col[k]];
      if (!def || !def.editable) throw new Error('Field "' + k + '" cannot be edited.');
      var v = patch[k];
      if (k === 'highPriority') v = v === true;
      else if (k === 'completedOn') v = v ? parseDay_(v) : '';
      else v = String(v == null ? '' : v).trim();
      if (k === 'status' && v && !STATUSES.some(function (s) { return s.name === v; })) throw new Error('Unknown status "' + v + '".');
      if (k === 'quarter' && v && !isQuarter(v)) throw new Error('Quarter must look like Q4 2026.');
      changes[k] = v;
    });

    // Moving into Done / For Upload stamps the completion date if nobody set one.
    if (changes.status && statusGroup(changes.status) === 'Completed' && !before.completedOn && !('completedOn' in changes)) {
      changes.completedOn = parseDay_(Utilities.formatDate(now, TZ, 'yyyy-MM-dd'));
    }

    Object.keys(changes).forEach(function (k) {
      var from = before[k];
      var to = changes[k];
      var toText = k === 'completedOn' ? fmtDate_(to, 'yyyy-MM-dd') : String(to);
      if (String(from) === toText) return;
      hit.sheet.getRange(hit.rowNum, col[k] + 1).setValue(to);
      log.push([now, who, String(id), ITEM_COLUMNS[col[k]].header, String(from), toText]);
    });

    if (log.length) {
      hit.sheet.getRange(hit.rowNum, col.updatedBy + 1, 1, 2).setValues([[who, now]]);
      // A new status restarts the "days in status" clock and clears the last nudge.
      if (log.some(function (l) { return l[3] === 'Status'; })) {
        hit.sheet.getRange(hit.rowNum, col.statusSince + 1, 1, 2).setValues([[now, '']]);
      }
      logActivity_(log);
    }
    var after = rowToItem_(hit.sheet.getRange(hit.rowNum, 1, 1, ITEM_COLUMNS.length).getValues()[0]);
    if (log.length) {
      try { onItemChanged_(before, after, actorName); } catch (e) { console.warn('Slack notify failed: ' + e); }
    }
    return after;
  });
}

function parseDay_(s) {
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Dates must look like 2026-10-15.');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Adds an item by hand (for AXOs not yet in an export). */
function addItem(item, actorName) {
  requireActor_(actorName);
  return withLock_(function () {
    var id = String(item && item.id || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('AXO ID must be a number.');
    if (!String(item.name || '').trim()) throw new Error('Name is required.');
    if (findRow_(id)) throw new Error('AXO ' + id + ' is already in the tracker.');
    var who = actor_(actorName);
    var now = new Date();
    var rec = {
      id: id, itemType: mapItemType(item.itemType || 'Bug'), name: String(item.name).trim(),
      workflowStep: item.workflowStep || '', priority: item.priority || '', developer: item.developer || '',
      reportedBy: item.reportedBy || '', releaseNotes: '', quarter: isQuarter(item.quarter) ? item.quarter : currentQuarter_(),
      highPriority: item.highPriority === true, axoCategory: item.axoCategory || deriveCategory(item.name),
      system: item.system || '', handler: item.handler || '', status: item.status || '',
      completedOn: '', commentDev: '', commentSed: '', updatedBy: who, updatedAt: now, lastImported: '', inLatestImport: false,
      statusSince: now, lastNudged: ''
    };
    var sh = sheet_(SHEETS.items);
    var at = firstFreeRow_(sh);
    ensureRows_(sh, at);
    sh.getRange(at, 1, 1, ITEM_COLUMNS.length).setValues([ITEM_COLUMNS.map(function (c) { return rec[c.key]; })]);
    checkboxes_(sh, at, 1);
    logActivity_([[now, who, id, 'Item', '', 'Added by hand']]);
    return rowToItem_(ITEM_COLUMNS.map(function (c) { return rec[c.key]; }));
  });
}

/**
 * Upserts an AXO items CSV export. CSV columns are refreshed on existing rows;
 * QA columns (status, handler, comments, ...) are never touched. AXOs that were deleted
 * from the tracker are skipped unless `readdDeleted` is true (they then come in as new).
 */
function importCsv(csvText, actorName, quarter, readdDeleted) {
  requireActor_(actorName);
  var incoming = csvToItems(parseCsv(csvText));
  if (quarter && !isQuarter(quarter)) throw new Error('Quarter must look like Q4 2026.');
  quarter = quarter || currentQuarter_();
  if (!incoming.length) throw new Error('No items found in the file.');
  return withLock_(function () {
    var data = readItems_();
    var sh = data.sheet;
    var col = colIndex_();
    var who = actor_(actorName);
    var now = new Date();
    var byId = {};
    data.rows.forEach(function (r) { byId[String(r.values[0])] = r; });
    var sourceKeys = ITEM_COLUMNS.filter(function (c) { return c.source; }).map(function (c) { return c.key; });
    var seen = {};
    var added = [], updated = 0, unchanged = 0, log = [];
    var deleted = readdDeleted ? {} : deletedIds_();
    var skippedDeleted = [];

    incoming.forEach(function (it) {
      seen[it.id] = true;
      var hit = byId[it.id];
      if (!hit && deleted[it.id]) { skippedDeleted.push(it.id); return; }
      if (!hit) {
        var rec = ITEM_COLUMNS.map(function (c) {
          if (c.source) return it[c.key];
          switch (c.key) {
            case 'highPriority': return it.priority === 'High';
            case 'axoCategory': return deriveCategory(it.name);
            case 'quarter': return quarter;
            case 'lastImported': return now;
            case 'inLatestImport': return true;
            case 'updatedBy': return who;
            case 'updatedAt': return now;
            case 'statusSince': return now;
            default: return '';
          }
        });
        added.push(rec);
        return;
      }
      var changed = false;
      sourceKeys.forEach(function (k) {
        var from = String(hit.values[col[k]] == null ? '' : hit.values[col[k]]);
        if (from !== it[k]) {
          if (k === 'workflowStep' || k === 'priority') log.push([now, who + ' (import)', it.id, ITEM_COLUMNS[col[k]].header, from, it[k]]);
          hit.values[col[k]] = it[k];
          changed = true;
        }
      });
      hit.values[col.lastImported] = now;
      hit.values[col.inLatestImport] = true;
      if (changed) updated++; else unchanged++;
    });

    var dropped = 0;
    data.rows.forEach(function (r) {
      if (!seen[String(r.values[0])] && r.values[col.inLatestImport] === true) { r.values[col.inLatestImport] = false; dropped++; }
    });

    // Write existing rows back in one call, then append new ones.
    if (data.rows.length) {
      var first = data.rows[0].rowNum, lastRow = data.rows[data.rows.length - 1].rowNum;
      var block = sh.getRange(first, 1, lastRow - first + 1, ITEM_COLUMNS.length).getValues();
      data.rows.forEach(function (r) { block[r.rowNum - first] = r.values; });
      sh.getRange(first, 1, block.length, ITEM_COLUMNS.length).setValues(block);
    }
    if (added.length) {
      var start = firstFreeRow_(sh);
      ensureRows_(sh, start + added.length - 1);
      sh.getRange(start, 1, added.length, ITEM_COLUMNS.length).setValues(added);
      checkboxes_(sh, start, added.length);
    }
    log.push([now, who, '', 'Import', '', added.length + ' added, ' + updated + ' updated, ' + unchanged + ' unchanged, ' + dropped + ' no longer in export' +
      (skippedDeleted.length ? ', ' + skippedDeleted.length + ' skipped (deleted earlier)' : '')]);
    logActivity_(log);

    var summary = { quarter: quarter, added: added.length, updated: updated, unchanged: unchanged, dropped: dropped,
      skippedDeleted: skippedDeleted.length,
      newHighPriority: added.filter(function (r) { return r[col.highPriority] === true; })
        .map(function (r) { return { id: String(r[0]), name: r[col.name] }; }) };
    PropertiesService.getScriptProperties().setProperty('LAST_IMPORT',
      Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ss") + '|' + who);
    try { onImported_(summary, actorName); } catch (e) { console.warn('Slack notify failed: ' + e); }
    return summary;
  });
}

// ---------------------------------------------------------------- delete / restore

/** IDs in the Deleted tab, as a lookup. */
function deletedIds_() {
  var sh = sheet_(SHEETS.deleted), out = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (String(r[0]).trim()) out[String(r[0])] = true; });
  }
  return out;
}

/** Deleting needs the DELETE_PASSCODE script property; five wrong tries lock it for ten minutes. */
function checkPasscode_(passcode) {
  var want = PropertiesService.getScriptProperties().getProperty('DELETE_PASSCODE');
  if (!want) throw new Error('Deleting is switched off. The tracker owner needs to set a delete passcode first.');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('delete_fails') || 0);
  if (fails >= 5) throw new Error('Too many wrong passcodes. Try again in 10 minutes.');
  if (String(passcode == null ? '' : passcode) !== want) {
    cache.put('delete_fails', String(fails + 1), 600);
    throw new Error('Wrong passcode.');
  }
  cache.remove('delete_fails');
}

/** Removes whole rows, bottom up, one call per run of neighbouring rows. */
function deleteRowNums_(sh, rowNums) {
  rowNums = rowNums.slice().sort(function (a, b) { return b - a; });
  // Sheets refuses to delete every row below the frozen header.
  if (sh.getMaxRows() - rowNums.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 20);
  var i = 0;
  while (i < rowNums.length) {
    var top = rowNums[i], n = 1;
    while (i + n < rowNums.length && rowNums[i + n] === top - n) n++;
    sh.deleteRows(top - n + 1, n);
    i += n;
  }
}

/**
 * Moves AXOs to the Deleted tab. Their notes stay in the Notes tab, so they come back
 * with the AXO if it is restored.
 */
function deleteItems(ids, passcode, actorName) {
  var want = {};
  (ids || []).forEach(function (id) { if (String(id).trim()) want[String(id).trim()] = true; });
  if (!Object.keys(want).length) throw new Error('Select at least one AXO to delete.');
  requireActor_(actorName);
  checkPasscode_(passcode);
  return withLock_(function () {
    var data = readItems_();
    var hits = data.rows.filter(function (r) { return want[String(r.values[0])]; });
    if (!hits.length) throw new Error('Those AXOs are no longer in the tracker.');
    var who = actor_(actorName), now = new Date();
    var del = sheet_(SHEETS.deleted);
    var out = hits.map(function (r) { return r.values.concat([who, now]); });
    var at = Math.max(del.getLastRow(), 1) + 1;
    ensureRows_(del, at + out.length - 1);
    del.getRange(at, 1, out.length, out[0].length).setValues(out);
    deleteRowNums_(data.sheet, hits.map(function (r) { return r.rowNum; }));
    var gone = hits.map(function (r) { return String(r.values[0]); });
    logActivity_([[now, who, '', 'Delete', '', gone.length + ' AXO' + (gone.length === 1 ? '' : 's') + ' moved to Deleted: ' +
      gone.slice(0, 40).join(', ') + (gone.length > 40 ? ', …' : '')]]);
    return { deleted: gone };
  });
}

/** Moves AXOs from the Deleted tab back into the tracker. IDs already in the tracker are left alone. */
function restoreItems_(ids, actorName) {
  var want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  return withLock_(function () {
    var del = sheet_(SHEETS.deleted);
    var items = sheet_(SHEETS.items);
    var width = ITEM_COLUMNS.length;
    var live = {};
    readItems_().rows.forEach(function (r) { live[String(r.values[0])] = true; });
    var restored = [], skipped = [], rowNums = [], rows = [];
    if (del.getLastRow() > 1) {
      del.getRange(2, 1, del.getLastRow() - 1, width).getValues().forEach(function (v, i) {
        var id = String(v[0]);
        if (!want[id] || restored.indexOf(id) >= 0) return;
        if (live[id]) { skipped.push(id); return; }
        restored.push(id); rowNums.push(i + 2); rows.push(v);
      });
    }
    if (rows.length) {
      var at = firstFreeRow_(items);
      ensureRows_(items, at + rows.length - 1);
      items.getRange(at, 1, rows.length, width).setValues(rows);
      checkboxes_(items, at, rows.length);
      deleteRowNums_(del, rowNums);
      logActivity_([[new Date(), actor_(actorName), '', 'Restore', '', restored.length + ' AXO' + (restored.length === 1 ? '' : 's') +
        ' restored: ' + restored.slice(0, 40).join(', ')]]);
    }
    return { restored: restored, skipped: skipped };
  });
}

/** Sheet menu: select rows in the Deleted tab, then run this to put them back. */
function restoreSelectedDeleted() {
  var ui = SpreadsheetApp.getUi();
  var range = SpreadsheetApp.getActiveRange();
  if (!range || range.getSheet().getName() !== SHEETS.deleted) {
    ui.alert('Open the Deleted tab and select the rows to restore first.');
    return;
  }
  var ids = range.getSheet().getRange(range.getRow(), 1, range.getNumRows(), 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(function (id) { return /^\d+$/.test(id); });
  if (!ids.length) { ui.alert('No AXO rows are selected.'); return; }
  var res = restoreItems_(ids, 'Sheet menu');
  ui.alert(res.restored.length + ' restored.' + (res.skipped.length ? ' ' + res.skipped.length + ' skipped because they are already in the tracker.' : ''));
}

function getItemDetail(id) {
  id = String(id);
  var notes = [], activity = [];
  var nsh = sheet_(SHEETS.notes);
  if (nsh.getLastRow() > 1) {
    nsh.getRange(2, 1, nsh.getLastRow() - 1, NOTE_COLUMNS.length).getValues().forEach(function (r) {
      if (String(r[1]) === id) notes.push(noteToObj_(r));
    });
  }
  var ash = sheet_(SHEETS.activity);
  if (ash.getLastRow() > 1) {
    ash.getRange(2, 1, ash.getLastRow() - 1, ACTIVITY_COLUMNS.length).getValues().forEach(function (r) {
      if (String(r[2]) === id) activity.push({ when: fmtDate_(r[0], "yyyy-MM-dd'T'HH:mm:ss"), who: String(r[1]), field: String(r[3]), from: String(r[4]), to: String(r[5]) });
    });
  }
  notes.reverse();
  activity.reverse();
  return { notes: notes, activity: activity.slice(0, 50) };
}

function noteToObj_(r) {
  return { noteId: String(r[0]), id: String(r[1]), kind: String(r[2]), text: String(r[3]), author: String(r[4]),
    createdAt: fmtDate_(r[5], "yyyy-MM-dd'T'HH:mm:ss") };
}

function addNote(id, kind, text, actorName) {
  requireActor_(actorName);
  if (kind === REVIEW_KIND) throw new Error('Use the review points form to send review points.');
  return withLock_(function () {
    var hit = findRow_(id);
    if (!hit) throw new Error('AXO ' + id + ' is no longer in the tracker.');
    var note = appendNote_(id, kind || 'General', text, actorName);
    try { onNoteAdded_(rowToItem_(hit.values), note, actorName); } catch (e) { console.warn('Slack notify failed: ' + e); }
    return note;
  });
}

var REVIEW_KIND = 'Review Points';

function appendNote_(id, kind, text, actorName) {
  text = String(text || '').trim();
  if (!text) throw new Error('Write a note first.');
  if (text.length > 5000) throw new Error('Notes are limited to 5,000 characters.');
  var row = [Utilities.getUuid(), String(id), String(kind), text, actor_(actorName), new Date()];
  sheet_(SHEETS.notes).appendRow(row);
  return noteToObj_(row);
}

/**
 * A reviewer (another QA) records review points: the status moves to Review Points,
 * the points are saved as a note, and the handler gets them as a Slack DM.
 */
function setReviewPoints(id, text, reviewerName) {
  if (!String(reviewerName || '').trim()) throw new Error('Pick your name in the top bar so the handler knows who reviewed.');
  var note = withLock_(function () {
    if (!findRow_(id)) throw new Error('AXO ' + id + ' is no longer in the tracker.');
    return appendNote_(id, REVIEW_KIND, text, reviewerName);
  });
  // updateItem takes the lock itself; its channel ping skips Review Points (the DM covers it).
  var item = updateItem(id, { status: REVIEW_KIND }, reviewerName);
  var slack;
  try { slack = sendReviewPoints_(item, note, reviewerName); } catch (e) { slack = { via: 'none', reason: String(e.message || e) }; }
  return { item: item, note: note, slack: slack };
}
