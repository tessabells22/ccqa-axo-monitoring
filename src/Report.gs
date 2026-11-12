/**
 * Report generation. buildReport() returns the report as plain, table-based HTML with
 * inline styles, so the same markup is shown in the tracker and converted to PDF by
 * reportPdf() (the Apps Script HTML-to-PDF converter ignores flexbox, grid and most CSS).
 *
 * Two things are reported:
 *   Snapshot   where the AXOs in scope (one quarter, or all) stand right now
 *   Activity   what happened between two dates: completions, review points, blockers
 */

var MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceDay_(day) {
  var m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? MONTHS_[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : '';
}

function plainName_(s) { return String(s || '').replace(/\s*<.*>$/, '').trim(); }

function reportOptions_(opts) {
  opts = opts || {};
  var quarter = String(opts.quarter || '');
  if (quarter && !isQuarter(quarter)) throw new Error('Quarter must look like Q4 2026.');
  var isDay = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); };
  var range = quarter ? quarterRange(quarter) : null;
  var today = today_();
  var from = isDay(opts.from) ? opts.from : range ? range.from : Utilities.formatDate(new Date(Date.now() - 6 * 864e5), TZ, 'yyyy-MM-dd');
  var to = isDay(opts.to) ? opts.to : range ? range.to : today;
  if (from > to) throw new Error('The report\'s start date is after its end date.');
  return { quarter: quarter, from: from, to: to, includeList: opts.includeList !== false, by: plainName_(opts.actorName), today: today };
}

/** Everything the report shows, as plain data (also what the tests check). */
function reportData_(opts) {
  var o = reportOptions_(opts);
  var all = readItems_().rows.map(function (r) { return rowToItem_(r.values, o.today); });
  var items = o.quarter ? all.filter(function (i) { return i.quarter === o.quarter; }) : all;
  var byId = {};
  items.forEach(function (i) { byId[i.id] = i; });
  var inPeriod = function (day) { return day && day >= o.from && day <= o.to; };

  // --- snapshot
  var groups = { 'Not Started': 0, 'In Progress': 0, 'Completed': 0, 'Discarded': 0 };
  var statusRows = [{ name: 'Not started', fill: '#E2E8F0', ink: '#14202C', bugs: 0, stories: 0, total: 0 }]
    .concat(STATUSES.map(function (s) { return { name: s.name, fill: s.fill, ink: s.ink, bugs: 0, stories: 0, total: 0 }; }));
  var statusIdx = {};
  statusRows.forEach(function (r, i) { statusIdx[r.name] = i; });
  var cats = {}, work = {};
  var catRow = function (k) { return cats[k] = cats[k] || { name: k, total: 0, 'Not Started': 0, 'In Progress': 0, 'Completed': 0, 'Discarded': 0 }; };
  var workRow = function (k) {
    return work[k] = work[k] || { name: k, total: 0, 'Not Started': 0, 'In Progress': 0, 'Completed': 0, 'Discarded': 0,
      completedInPeriod: 0, pointsReceived: 0, reviewsGiven: 0, backToDev: 0 };
  };
  var hpOpen = [], stuck = [], unassignedOpen = 0, completedList = [];

  items.forEach(function (i) {
    var g = statusGroup(i.status);
    groups[g]++;
    var sr = statusRows[statusIdx[i.status || 'Not started']] || statusRows[0];
    sr.total++;
    if (i.itemType === 'Bug') sr.bugs++; else if (i.itemType === 'User Story') sr.stories++;
    var c = catRow(i.axoCategory || 'No category'); c.total++; c[g]++;
    var w = workRow(i.handler || 'Unassigned'); w.total++; w[g]++;
    var open = g === 'Not Started' || g === 'In Progress';
    if (open && i.highPriority) hpOpen.push(i);
    if (open && !i.handler) unassignedOpen++;
    if (NUDGE_STATUSES.indexOf(i.status) >= 0 && i.daysInStatus >= NUDGE_AFTER_DAYS) stuck.push(i);
    if (g === 'Completed' && inPeriod(i.completedOn)) { completedList.push(i); w.completedInPeriod++; }
  });

  // --- activity in the period
  var reviewPoints = 0, blockers = [];
  var nsh = sheet_(SHEETS.notes);
  if (nsh.getLastRow() > 1) {
    nsh.getRange(2, 1, nsh.getLastRow() - 1, NOTE_COLUMNS.length).getValues().forEach(function (r) {
      var item = byId[String(r[1])];
      var day = fmtDate_(r[5], 'yyyy-MM-dd').slice(0, 10);
      if (!item || !inPeriod(day)) return;
      var kind = String(r[2]), author = plainName_(r[4]);
      if (kind === REVIEW_KIND) {
        reviewPoints++;
        workRow(item.handler || 'Unassigned').pointsReceived++;
        if (author) workRow(author).reviewsGiven++;
      } else if (kind === 'Blocker') {
        blockers.push({ id: item.id, name: item.name, handler: item.handler, text: String(r[3]), author: author, day: day });
      }
    });
  }
  var statusChanges = 0, backToDev = 0;
  var activityRows = readAll_(SHEETS.activity, ACTIVITY_COLUMNS.length);
  activityRows.forEach(function (r) {
    var item = byId[String(r[2])];
    if (!item || !inPeriod(fmtDate_(r[0], 'yyyy-MM-dd').slice(0, 10))) return;
    if (String(r[3]) === 'Status') statusChanges++;
    // Same rule as the tracker's rework count, for this one row.
    var one = reworkCounts([r], [])[item.id];
    if (one && one.back) { backToDev++; workRow(item.handler || 'Unassigned').backToDev++; }
  });
  // Rework over each AXO's whole life (not just the period), for the most-reworked list.
  var rework = reworkCounts(activityRows, readAll_(SHEETS.notes, NOTE_COLUMNS.length));
  var reworked = items.map(function (i) {
    var rw = rework[i.id] || { rounds: 0, back: 0 };
    return { item: i, rounds: rw.rounds, back: rw.back, total: rw.rounds + rw.back };
  }).filter(function (x) { return x.total; }).sort(function (a, b) { return b.total - a.total || b.rounds - a.rounds; });

  var live = items.length - groups['Discarded'];
  var byTotal = function (a, b) { return b.total - a.total || (a.name < b.name ? -1 : 1); };
  var workload = Object.keys(work).map(function (k) { return work[k]; }).sort(function (a, b) {
    if (a.name === 'Unassigned') return 1;
    if (b.name === 'Unassigned') return -1;
    return byTotal(a, b);
  });
  return {
    options: o,
    scopeLabel: o.quarter || 'All quarters',
    total: items.length, groups: groups,
    completionRate: live ? Math.round(groups['Completed'] / live * 100) : 0,
    unassignedOpen: unassignedOpen,
    statusRows: statusRows.filter(function (r) { return r.total; }),
    categories: Object.keys(cats).map(function (k) { return cats[k]; }).sort(byTotal),
    workload: workload,
    activity: { completed: completedList.length, statusChanges: statusChanges, reviewPoints: reviewPoints, blockers: blockers.length, backToDev: backToDev },
    reworked: reworked,
    completedList: completedList.sort(function (a, b) { return a.completedOn < b.completedOn ? -1 : a.completedOn > b.completedOn ? 1 : 0; }),
    stuck: stuck.sort(function (a, b) { return b.daysInStatus - a.daysInStatus; }),
    hpOpen: hpOpen,
    blockers: blockers,
    items: items.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); })
  };
}

// ---------------------------------------------------------------- HTML

function h_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var R_ = {
  ink: '#14202C', muted: '#5A6878', line: '#DDE5EE', head: '#EEF3F8', brand: '#0F6EC8', orange: '#F19305',
  font: 'font-family:Arial,Helvetica,sans-serif;'
};

function rTable_(headers, rows, opts) {
  opts = opts || {};
  var align = opts.align || [];
  var cell = 'padding:5px 8px;border-bottom:1px solid ' + R_.line + ';font-size:11px;vertical-align:top;';
  var out = '<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;' + R_.font + 'margin:0 0 6px 0">';
  out += '<tr>' + headers.map(function (t, i) {
    return '<th style="' + cell + 'background:' + R_.head + ';color:' + R_.muted + ';font-size:9px;letter-spacing:.5px;text-transform:uppercase;text-align:' +
      (align[i] || 'left') + (opts.widths && opts.widths[i] ? ';width:' + opts.widths[i] : '') + '">' + h_(t) + '</th>';
  }).join('') + '</tr>';
  rows.forEach(function (r) {
    out += '<tr>' + r.map(function (c, i) {
      var isObj = c !== null && typeof c === 'object';
      var style = cell + 'text-align:' + (align[i] || 'left') + ';color:' + R_.ink + ';' + (isObj && c.style ? c.style : '');
      return '<td style="' + style + '">' + (isObj ? (c.html != null ? c.html : h_(c.text)) : h_(c)) + '</td>';
    }).join('') + '</tr>';
  });
  if (!rows.length) out += '<tr><td colspan="' + headers.length + '" style="' + cell + 'color:' + R_.muted + '">' + h_(opts.empty || 'Nothing to show.') + '</td></tr>';
  return out + '</table>';
}

function rHeading_(text, note) {
  return '<h2 style="' + R_.font + 'font-size:14px;color:' + R_.ink + ';margin:22px 0 3px 0;padding:0">' + h_(text) + '</h2>' +
    (note ? '<p style="' + R_.font + 'font-size:10.5px;color:' + R_.muted + ';margin:0 0 8px 0">' + h_(note) + '</p>' : '<div style="height:6px"></div>');
}

/**
 * Status colours are drawn as borders, with dark text. Printers and PDF converters
 * often drop background fills, which would leave white-on-colour labels unreadable.
 */
function rStatusStyle_(fill) {
  return 'border-left:7px solid ' + fill + ';padding-left:8px;font-weight:bold;';
}

function rStatus_(name) {
  for (var i = 0; i < STATUSES.length; i++) {
    if (STATUSES[i].name === name) return { text: name, style: rStatusStyle_(STATUSES[i].fill) };
  }
  return { text: name || 'Not started', style: rStatusStyle_('#94A3B8') + 'font-weight:normal;color:' + R_.muted + ';' };
}

function rBar_(pct, fill) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  if (!pct) return '';
  return '<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse"><tr>' +
    '<td width="' + pct + '%" style="border-top:9px solid ' + fill + ';height:0;font-size:1px;line-height:1px;padding:0"></td>' +
    (pct < 100 ? '<td width="' + (100 - pct) + '%" style="font-size:1px;line-height:1px;padding:0"></td>' : '') + '</tr></table>';
}

function rTiles_(tiles) {
  var out = '<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;' + R_.font + '"><tr>';
  tiles.forEach(function (t, i) {
    if (i && i % 4 === 0) out += '</tr><tr>';
    out += '<td width="25%" style="border:1px solid ' + R_.line + ';border-top:3px solid ' + (t.color || R_.brand) + ';padding:8px 10px;vertical-align:top">' +
      '<div style="font-size:9px;letter-spacing:.5px;text-transform:uppercase;color:' + R_.muted + '">' + h_(t.label) + '</div>' +
      '<div style="font-size:22px;font-weight:bold;color:' + (t.ink || R_.ink) + ';line-height:1.2">' + h_(t.value) + '</div>' +
      '<div style="font-size:10px;color:' + R_.muted + '">' + h_(t.sub || '') + '</div></td>';
  });
  return out + '</tr></table>';
}

function reportHtml_(d) {
  var o = d.options;
  var period = niceDay_(o.from) + ' to ' + niceDay_(o.to);
  var out = '<div style="' + R_.font + 'color:' + R_.ink + ';background:#FFFFFF;font-size:11px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact">';

  out += '<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;' + R_.font + 'border-bottom:2px solid ' + R_.brand + '"><tr>' +
    '<td style="padding:0 0 10px 0"><div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:' + R_.brand + '">ShipERP &middot; Carrier Compliance QA</div>' +
    '<div style="font-size:22px;font-weight:bold;color:' + R_.ink + '">AXO Monitoring Report</div>' +
    '<div style="font-size:12px;color:' + R_.muted + '">' + h_(d.scopeLabel) + ' &middot; activity from ' + h_(period) + '</div></td>' +
    '<td style="padding:0 0 10px 0;text-align:right;vertical-align:bottom;font-size:10px;color:' + R_.muted + '">Generated ' + h_(niceDay_(o.today)) +
    (o.by ? '<br>by ' + h_(o.by) : '') + '</td></tr></table>';

  // 1. Summary
  out += rHeading_('Summary', 'Where the ' + d.total + ' AXOs in ' + d.scopeLabel + ' stand today.');
  out += rTiles_([
    { label: 'Total AXOs', value: d.total, sub: d.scopeLabel },
    { label: 'Not started', value: d.groups['Not Started'], sub: 'no status yet', color: '#8A97A6' },
    { label: 'In progress', value: d.groups['In Progress'], sub: 'QA, BA/DEV, review', color: '#059BD7' },
    { label: 'Completed', value: d.groups['Completed'], sub: 'Done + For Upload', color: '#1A8A4A' },
    { label: 'Discarded', value: d.groups['Discarded'], sub: 'Moved + Withdraw', color: '#8A97A6' },
    { label: 'Completion rate', value: d.completionRate + '%', sub: 'completed / not discarded', color: '#1A8A4A' },
    { label: 'High priority open', value: d.hpOpen.length, sub: 'not completed', color: '#C2372F', ink: d.hpOpen.length ? '#C2372F' : R_.ink },
    { label: 'Stuck ' + NUDGE_AFTER_DAYS + '+ days', value: d.stuck.length, sub: 'working days in one status', color: R_.orange }
  ]);

  // 2. Status
  out += rHeading_('Status breakdown');
  out += rTable_(['Status', 'Bugs', 'User Stories', 'Total', '%', 'Share'], d.statusRows.map(function (r) {
    var pct = d.total ? r.total / d.total * 100 : 0;
    var fill = r.fill === '#E2E8F0' ? '#94A3B8' : r.fill;
    return [{ text: r.name, style: rStatusStyle_(fill) }, r.bugs, r.stories,
      { text: r.total, style: 'font-weight:bold;' }, Math.round(pct) + '%', { html: rBar_(pct, fill), style: 'vertical-align:middle;' }];
  }), { align: ['left', 'right', 'right', 'right', 'right', 'left'], widths: ['24%', '10%', '14%', '10%', '8%', '34%'] });

  // 3. Category
  out += rHeading_('By AXO category');
  out += rTable_(['Category', 'Total', 'Not started', 'In progress', 'Completed', 'Discarded'], d.categories.map(function (c) {
    return [c.name, { text: c.total, style: 'font-weight:bold;' }, c['Not Started'], c['In Progress'], c['Completed'], c['Discarded']];
  }), { align: ['left', 'right', 'right', 'right', 'right', 'right'] });

  // 4. Workload
  out += rHeading_('QA workload', 'AXOs per handler today. The last four columns count the report period only.');
  out += rTable_(['Handler', 'Total', 'Not started', 'In progress', 'Completed', 'Discarded', 'Completed in period', 'Review points received', 'Back to BA/DEV', 'Reviews given'],
    d.workload.map(function (w) {
      return [{ text: w.name, style: w.name === 'Unassigned' ? 'color:' + R_.muted + ';' : 'font-weight:bold;' }, { text: w.total, style: 'font-weight:bold;' },
        w['Not Started'], w['In Progress'], w['Completed'], w['Discarded'], w.completedInPeriod, w.pointsReceived, w.backToDev, w.reviewsGiven];
    }), { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'], empty: 'No AXOs in scope.' });

  // 5. Activity
  out += rHeading_('Activity, ' + period);
  out += rTiles_([
    { label: 'Completed', value: d.activity.completed, sub: 'by Date of Completion', color: '#1A8A4A' },
    { label: 'Status changes', value: d.activity.statusChanges, sub: 'logged in the tracker', color: '#059BD7' },
    { label: 'Review points', value: d.activity.reviewPoints, sub: 'rounds sent to handlers', color: '#FFC000' },
    { label: 'Blockers raised', value: d.activity.blockers, sub: 'Blocker notes', color: '#C2372F' }
  ]);

  out += rHeading_('Completed in the period');
  out += rTable_(['AXO', 'Type', 'Name', 'Handler', 'Status', 'Completed'], d.completedList.map(function (i) {
    return [i.id, i.itemType, i.name, i.handler || '—', rStatus_(i.status), niceDay_(i.completedOn)];
  }), { widths: ['8%', '11%', '41%', '14%', '12%', '14%'], empty: 'Nothing was completed between these dates.' });

  // 6. Attention
  out += rHeading_('Needs attention');
  out += '<p style="' + R_.font + 'font-size:11px;font-weight:bold;margin:6px 0 4px 0">In the same status for ' + NUDGE_AFTER_DAYS + '+ working days (' + d.stuck.length + ')</p>';
  out += rTable_(['AXO', 'Name', 'Handler', 'Status', 'Working days'], d.stuck.map(function (i) {
    return [i.id, i.name, i.handler || '—', rStatus_(i.status), { text: i.daysInStatus, style: 'font-weight:bold;' }];
  }), { align: ['left', 'left', 'left', 'left', 'right'], widths: ['8%', '48%', '16%', '16%', '12%'], empty: 'Nothing is stuck.' });
  out += '<p style="' + R_.font + 'font-size:11px;font-weight:bold;margin:12px 0 4px 0">High priority, still open (' + d.hpOpen.length + ')</p>';
  out += rTable_(['AXO', 'Name', 'Handler', 'Status'], d.hpOpen.map(function (i) {
    return [i.id, i.name, i.handler || '—', rStatus_(i.status)];
  }), { widths: ['8%', '56%', '18%', '18%'], empty: 'No high-priority AXOs are open.' });
  if (d.blockers.length) {
    out += '<p style="' + R_.font + 'font-size:11px;font-weight:bold;margin:12px 0 4px 0">Blockers raised in the period (' + d.blockers.length + ')</p>';
    out += rTable_(['AXO', 'Blocker', 'Raised by', 'Date'], d.blockers.map(function (b) {
      return [b.id, b.text.length > 220 ? b.text.slice(0, 220) + '…' : b.text, b.author, niceDay_(b.day)];
    }), { widths: ['8%', '60%', '16%', '16%'] });
  }
  if (d.unassignedOpen) {
    out += '<p style="' + R_.font + 'font-size:11px;color:' + R_.muted + ';margin:10px 0 0 0">' + d.unassignedOpen + ' open AXO' + (d.unassignedOpen === 1 ? ' has' : 's have') + ' no handler.</p>';
  }

  // Rework
  out += rHeading_('Most reworked AXOs', 'Review-point rounds, and times an AXO went back to development (status from a QA stage to Ongoing BA/DEV, or its AXO workflow step to Rework). Counted over the AXO\'s whole time in the tracker.');
  out += rTable_(['AXO', 'Name', 'Handler', 'Status', 'Review rounds', 'Back to BA/DEV'], d.reworked.slice(0, 10).map(function (x) {
    return [x.item.id, x.item.name, x.item.handler || '—', rStatus_(x.item.status), { text: x.rounds, style: 'font-weight:bold;' }, { text: x.back, style: 'font-weight:bold;' }];
  }), { align: ['left', 'left', 'left', 'left', 'right', 'right'], widths: ['8%', '44%', '14%', '14%', '10%', '10%'], empty: 'No rework recorded for these AXOs.' });

  // 7. Full list
  if (o.includeList) {
    out += rHeading_('All AXOs in ' + d.scopeLabel + ' (' + d.items.length + ')');
    out += rTable_(['AXO', 'Type', 'Category', 'Name', 'Handler', 'Status', 'Days', 'Completed'], d.items.map(function (i) {
      return [i.id, i.itemType, i.axoCategory || '—', i.name, i.handler || '—', rStatus_(i.status),
        i.daysInStatus == null ? '—' : i.daysInStatus, i.completedOn ? niceDay_(i.completedOn) : '—'];
    }), { align: ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'], widths: ['7%', '10%', '9%', '34%', '12%', '12%', '5%', '11%'] });
  }

  out += '<p style="' + R_.font + 'font-size:9px;color:' + R_.muted + ';margin:16px 0 0 0;border-top:1px solid ' + R_.line + ';padding-top:6px">' +
    'Days are working days (Tuesday to Saturday) in the current status. Source: CCQA AXO Monitoring Tracker.</p>';
  return out + '</div>';
}

// ---------------------------------------------------------------- API

function reportName_(d) {
  return 'CCQA-AXO-Report_' + d.scopeLabel.replace(/\s+/g, '-') + '_' + d.options.from + '_to_' + d.options.to;
}

/** The report as HTML, for the preview in the tracker. */
function buildReport(opts) {
  var d = reportData_(opts);
  return { html: reportHtml_(d), title: 'AXO Monitoring Report, ' + d.scopeLabel, filename: reportName_(d) + '.pdf' };
}

/** The same report as a PDF, base64-encoded for the browser to download. */
function reportPdf(opts) {
  var d = reportData_(opts);
  var name = reportName_(d);
  var doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + h_(name) + '</title></head><body style="margin:0">' + reportHtml_(d) + '</body></html>';
  var pdf = Utilities.newBlob(doc, 'text/html', name + '.html').getAs('application/pdf');
  return { base64: Utilities.base64Encode(pdf.getBytes()), filename: name + '.pdf' };
}
