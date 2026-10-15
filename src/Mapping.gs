/**
 * Pure data rules for the CCQA AXO tracker. No Apps Script services are used
 * here, so the same file runs in Node for tests (see tests/mapping.test.js).
 */

/** Columns in the Items sheet, in order. Keys are what the web app uses. */
var ITEM_COLUMNS = [
  // From the AXO CSV export (refreshed on every import)
  { key: 'id',            header: 'ID',                 source: true },
  { key: 'itemType',      header: 'Item Type',          source: true },
  { key: 'name',          header: 'Name',               source: true },
  { key: 'workflowStep',  header: 'Workflow Step',      source: true },
  { key: 'priority',      header: 'Priority',           source: true },
  { key: 'developer',     header: 'Developer',          source: true },
  { key: 'reportedBy',    header: 'BA',                 source: true },  // "Reported By" in the AXO export
  { key: 'releaseNotes',  header: 'Release Notes Description', source: true },
  // QA tracking (owned by the team, never overwritten by an import)
  { key: 'quarter',       header: 'Quarter',            editable: true },
  { key: 'highPriority',  header: 'High Priority',      editable: true },
  { key: 'axoCategory',   header: 'AXO Category',       editable: true },
  { key: 'system',        header: 'System',             editable: true },
  { key: 'handler',       header: 'Handler',            editable: true },
  { key: 'status',        header: 'Status',             editable: true },
  { key: 'completedOn',   header: 'Date of Completion', editable: true },
  { key: 'commentDev',    header: 'Comment/Note (DEV)', editable: true },
  { key: 'commentSed',    header: 'Comment/Note (SED)', editable: true },
  // Bookkeeping
  { key: 'updatedBy',     header: 'Updated By' },
  { key: 'updatedAt',     header: 'Updated At' },
  { key: 'lastImported',  header: 'Last Imported' },
  { key: 'inLatestImport', header: 'In Latest Import' }
];

var NOTE_COLUMNS = ['Note ID', 'AXO ID', 'Kind', 'Note', 'Author', 'Created At'];
var ACTIVITY_COLUMNS = ['When', 'Who', 'AXO ID', 'Field', 'From', 'To'];

/** Status colours taken from the AXO Monitoring 2026 workbook. */
var STATUSES = [
  { name: 'Ongoing QA',      fill: '#DE0AEE', ink: '#FFFFFF', group: 'In Progress' },
  { name: 'Ongoing BA/DEV',  fill: '#17781A', ink: '#FFFFFF', group: 'In Progress' },
  { name: 'Awaiting BA/DEV', fill: '#E97132', ink: '#FFFFFF', group: 'In Progress' },
  { name: 'For Review',      fill: '#4614F5', ink: '#FFFFFF', group: 'In Progress' },
  { name: 'Review Points',   fill: '#FFC000', ink: '#1F1F1F', group: 'In Progress' },
  { name: 'For Upload',      fill: '#7030A0', ink: '#FFFFFF', group: 'Completed' },
  { name: 'Done',            fill: '#475569', ink: '#FFFFFF', group: 'Completed' },
  { name: 'Moved',           fill: '#00B0F0', ink: '#0B1B26', group: 'Discarded' },
  { name: 'Withdraw',        fill: '#FF0000', ink: '#FFFFFF', group: 'Discarded' }
];

/** Defaults for the Lists sheet, from the workbook's "Drop down List" tab. */
var DEFAULT_LISTS = {
  'AXO Category': ['ERPIS', 'SERPCAR'],
  'System': ['DEV 800', 'DEV 850', 'SED', 'EFT', 'WD1', 'DEV 850/SED', 'DEV 800/SED', 'DEV/SED', 'WD1/EFT'],
  'Handler': ['Abbey - QA', 'AJ - QA', 'Anika - QA', 'Carla - QA', 'Cess - QA', 'Dan - QA', 'Jhopet - QA',
              'Joanne - QA', 'Julius - QA', 'Kat - QA', 'Ley - QA', 'Liza - QA', 'Loraleen - QA', 'Ron - QA',
              'Sha - QA', 'Tessa - QA', 'Von - QA'],
  'Note Kind': ['General', 'DEV', 'SED', 'Blocker']
};

var ITEM_TYPE_MAP = { defects: 'Bug', defect: 'Bug', features: 'User Story', feature: 'User Story' };

function mapItemType(raw) {
  var key = String(raw || '').trim().toLowerCase();
  return ITEM_TYPE_MAP[key] || String(raw || '').trim();
}

/** ERPIS items are prefixed ERPIS; SERPC / SERPCAR items belong to SERPCAR. */
function deriveCategory(name) {
  var n = String(name || '').trim().toUpperCase();
  if (/^ERPIS\b/.test(n)) return 'ERPIS';
  if (/^SERPC(AR)?\b/.test(n)) return 'SERPCAR';
  return '';
}

/** "Q4 2026" for a year and 1-based month. */
function quarterLabel(year, month) {
  return 'Q' + (Math.floor((Number(month) - 1) / 3) + 1) + ' ' + year;
}

function isQuarter(s) {
  return /^Q[1-4] \d{4}$/.test(String(s || ''));
}

function statusGroup(status) {
  if (!status) return 'Not Started';
  for (var i = 0; i < STATUSES.length; i++) {
    if (STATUSES[i].name === status) return STATUSES[i].group;
  }
  return 'In Progress';
}

/** RFC 4180 CSV parser. Handles quoted commas, quotes and newlines, and a BOM. */
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  var rows = [], row = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
}

/**
 * Turns the AXO "items" CSV export into item records.
 * The export repeats some headers: "Developer" appears twice (the first is filled
 * for defects, the second for features) and the release-notes column appears twice.
 * The first non-empty value wins.
 */
function csvToItems(rows) {
  if (!rows || !rows.length) throw new Error('The file is empty.');
  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function cols(name) {
    var out = [];
    header.forEach(function (h, i) { if (h === name) out.push(i); });
    return out;
  }
  var map = {
    id: cols('id'),
    itemType: cols('item type'),
    name: cols('name'),
    workflowStep: cols('workflow step'),
    priority: cols('priority'),
    developer: cols('developer'),
    reportedBy: cols('reported by'),
    releaseNotes: cols('non-technical description for release notes')
  };
  if (!map.id.length || !map.name.length || !map.itemType.length) {
    throw new Error('This does not look like an AXO items export. Expected ID, Item Type and Name columns.');
  }
  function pick(r, idxs) {
    for (var k = 0; k < idxs.length; k++) {
      var v = String(r[idxs[k]] == null ? '' : r[idxs[k]]).trim();
      if (v) return v.replace(/\s{2,}/g, ' ');
    }
    return '';
  }
  var seen = {}, items = [];
  for (var r = 1; r < rows.length; r++) {
    var id = pick(rows[r], map.id);
    if (!id || seen[id]) continue;
    seen[id] = true;
    items.push({
      id: id,
      itemType: mapItemType(pick(rows[r], map.itemType)),
      name: pick(rows[r], map.name),
      workflowStep: pick(rows[r], map.workflowStep),
      priority: pick(rows[r], map.priority),
      developer: pick(rows[r], map.developer),
      reportedBy: pick(rows[r], map.reportedBy),
      releaseNotes: pick(rows[r], map.releaseNotes)
    });
  }
  return items;
}

if (typeof module !== 'undefined') {
  module.exports = {
    ITEM_COLUMNS: ITEM_COLUMNS, STATUSES: STATUSES, DEFAULT_LISTS: DEFAULT_LISTS,
    mapItemType: mapItemType, deriveCategory: deriveCategory, statusGroup: statusGroup,
    quarterLabel: quarterLabel, isQuarter: isQuarter,
    parseCsv: parseCsv, csvToItems: csvToItems
  };
}
