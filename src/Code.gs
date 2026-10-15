/**
 * CCQA AXO Monitoring Tracker: Apps Script web app over a Google Sheet.
 *
 * Sheets (created by setup()):
 *   Items     one row per AXO item; CSV columns + QA tracking columns
 *   Notes     append-only team notes, one row per note
 *   Activity  audit trail of every field change and import
 *   Lists     dropdown values (handlers, systems, categories) the team can edit
 */

var SHEETS = { items: 'Items', notes: 'Notes', activity: 'Activity', lists: 'Lists' };
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
    .addItem('Send Slack test message', 'testSlack')
    .addItem('Send daily digest now', 'sendDailyDigest')
    .addItem('Install daily digest trigger', 'installTriggers')
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
  var lists = ss.getSheetByName(SHEETS.lists);
  if (!lists) {
    lists = ss.insertSheet(SHEETS.lists);
    var names = Object.keys(DEFAULT_LISTS).concat(['Handler Slack ID']);
    lists.getRange(1, 1, 1, names.length).setValues([names]).setFontWeight('bold');
    names.forEach(function (n, i) {
      var vals = DEFAULT_LISTS[n] || [];
      if (vals.length) lists.getRange(2, i + 1, vals.length, 1).setValues(vals.map(function (v) { return [v]; }));
    });
    lists.setFrozenRows(1);
  }
  formatItems_(items);
  return 'Setup complete';
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
    releaseNotes: 260, highPriority: 95, axoCategory: 100, system: 100, handler: 120, status: 130,
    completedOn: 120, commentDev: 420, commentSed: 300, updatedBy: 150, updatedAt: 150, lastImported: 150, inLatestImport: 110 };
  Object.keys(widths).forEach(function (k) { sh.setColumnWidth(col[k] + 1, widths[k]); });

  var body = function (k) { return sh.getRange(2, col[k] + 1, maxRows - 1, 1); };
  var listRule = function (header) {
    var lists = sheet_(SHEETS.lists);
    var idx = lists.getRange(1, 1, 1, lists.getLastColumn()).getValues()[0].indexOf(header);
    if (idx < 0) return null;
    return SpreadsheetApp.newDataValidation()
      .requireValueInRange(lists.getRange(2, idx + 1, 200, 1), true).setAllowInvalid(true).build();
  };
  // Checkboxes only on rows that hold data: an unchecked box counts as content and
  // would push getLastRow() to the bottom of the sheet.
  checkboxes_(sh, 2, firstFreeRow_(sh) - 2);
  ['axoCategory', 'system', 'handler'].forEach(function (k) {
    var header = { axoCategory: 'AXO Category', system: 'System', handler: 'Handler' }[k];
    var rule = listRule(header);
    if (rule) body(k).setDataValidation(rule);
  });
  body('status').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES.map(function (s) { return s.name; }), true).setAllowInvalid(false).build())
    .setFontWeight('bold');
  body('completedOn').setNumberFormat('yyyy-mm-dd');
  body('updatedAt').setNumberFormat('yyyy-mm-dd hh:mm');
  body('lastImported').setNumberFormat('yyyy-mm-dd hh:mm');
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

/** First row below the last non-empty ID. */
function firstFreeRow_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 2;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]).trim()) return i + 3;
  return 2;
}

function checkboxes_(sh, startRow, count) {
  if (count < 1) return;
  var col = colIndex_();
  sh.getRange(startRow, col.highPriority + 1, count, 1).insertCheckboxes();
  sh.getRange(startRow, col.inLatestImport + 1, count, 1).insertCheckboxes();
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

function rowToItem_(row) {
  var item = {};
  ITEM_COLUMNS.forEach(function (c, i) { item[c.key] = row[i]; });
  item.id = String(item.id);
  item.highPriority = item.highPriority === true || String(item.highPriority).toUpperCase() === 'TRUE';
  item.inLatestImport = item.inLatestImport === true || String(item.inLatestImport).toUpperCase() === 'TRUE';
  item.completedOn = fmtDate_(item.completedOn, 'yyyy-MM-dd');
  item.updatedAt = fmtDate_(item.updatedAt, "yyyy-MM-dd'T'HH:mm:ss");
  item.lastImported = fmtDate_(item.lastImported, "yyyy-MM-dd'T'HH:mm:ss");
  ['itemType', 'name', 'workflowStep', 'priority', 'developer', 'reportedBy', 'releaseNotes', 'axoCategory',
   'system', 'handler', 'status', 'commentDev', 'commentSed', 'updatedBy'].forEach(function (k) {
    item[k] = item[k] == null ? '' : String(item[k]);
  });
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
  var data = readItems_();
  var counts = {};
  var notes = sheet_(SHEETS.notes);
  if (notes.getLastRow() > 1) {
    notes.getRange(2, 2, notes.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var id = String(r[0]);
      counts[id] = (counts[id] || 0) + 1;
    });
  }
  var lists = readLists_();
  var props = PropertiesService.getScriptProperties();
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) {}
  return {
    items: data.rows.map(function (r) { return rowToItem_(r.values); }),
    noteCounts: counts,
    lists: {
      categories: lists['AXO Category'] || DEFAULT_LISTS['AXO Category'],
      systems: lists['System'] || DEFAULT_LISTS['System'],
      handlers: lists['Handler'] || DEFAULT_LISTS['Handler'],
      noteKinds: lists['Note Kind'] || DEFAULT_LISTS['Note Kind']
    },
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
      reportedBy: item.reportedBy || '', releaseNotes: '',
      highPriority: item.highPriority === true, axoCategory: item.axoCategory || deriveCategory(item.name),
      system: item.system || '', handler: item.handler || '', status: item.status || '',
      completedOn: '', commentDev: '', commentSed: '', updatedBy: who, updatedAt: now, lastImported: '', inLatestImport: false
    };
    var sh = sheet_(SHEETS.items);
    var at = firstFreeRow_(sh);
    sh.getRange(at, 1, 1, ITEM_COLUMNS.length).setValues([ITEM_COLUMNS.map(function (c) { return rec[c.key]; })]);
    checkboxes_(sh, at, 1);
    logActivity_([[now, who, id, 'Item', '', 'Added by hand']]);
    return rowToItem_(ITEM_COLUMNS.map(function (c) { return rec[c.key]; }));
  });
}

/**
 * Upserts an AXO items CSV export. CSV columns are refreshed on existing rows;
 * QA columns (status, handler, comments, ...) are never touched.
 */
function importCsv(csvText, actorName) {
  var incoming = csvToItems(parseCsv(csvText));
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

    incoming.forEach(function (it) {
      seen[it.id] = true;
      var hit = byId[it.id];
      if (!hit) {
        var rec = ITEM_COLUMNS.map(function (c) {
          if (c.source) return it[c.key];
          switch (c.key) {
            case 'highPriority': return it.priority === 'High';
            case 'axoCategory': return deriveCategory(it.name);
            case 'lastImported': return now;
            case 'inLatestImport': return true;
            case 'updatedBy': return who;
            case 'updatedAt': return now;
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
      sh.getRange(start, 1, added.length, ITEM_COLUMNS.length).setValues(added);
      checkboxes_(sh, start, added.length);
    }
    log.push([now, who, '', 'Import', '', added.length + ' added, ' + updated + ' updated, ' + unchanged + ' unchanged, ' + dropped + ' no longer in export']);
    logActivity_(log);

    var summary = { added: added.length, updated: updated, unchanged: unchanged, dropped: dropped,
      newHighPriority: added.filter(function (r) { return r[col.highPriority] === true; })
        .map(function (r) { return { id: String(r[0]), name: r[col.name] }; }) };
    PropertiesService.getScriptProperties().setProperty('LAST_IMPORT',
      Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ss") + '|' + who);
    try { onImported_(summary, actorName); } catch (e) { console.warn('Slack notify failed: ' + e); }
    return summary;
  });
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
  text = String(text || '').trim();
  if (!text) throw new Error('Write a note first.');
  if (text.length > 5000) throw new Error('Notes are limited to 5,000 characters.');
  return withLock_(function () {
    var hit = findRow_(id);
    if (!hit) throw new Error('AXO ' + id + ' is no longer in the tracker.');
    var row = [Utilities.getUuid(), String(id), String(kind || 'General'), text, actor_(actorName), new Date()];
    sheet_(SHEETS.notes).appendRow(row);
    var note = noteToObj_(row);
    try { onNoteAdded_(rowToItem_(hit.values), note, actorName); } catch (e) { console.warn('Slack notify failed: ' + e); }
    return note;
  });
}
