const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('./fake-gas');
const M = require('../src/Mapping.gs');

const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'axo-items-sample.csv'), 'utf8');

test('item type maps defects to Bug and features to User Story', () => {
  assert.strictEqual(M.mapItemType('defects'), 'Bug');
  assert.strictEqual(M.mapItemType('Features'), 'User Story');
  assert.strictEqual(M.mapItemType(' Defects '), 'Bug');
  assert.strictEqual(M.mapItemType('support'), 'support');
});

test('AXO category comes from the name prefix', () => {
  assert.strictEqual(M.deriveCategory('ERPIS UPS REST: x'), 'ERPIS');
  assert.strictEqual(M.deriveCategory('SERPCAR FedEx'), 'SERPCAR');
  assert.strictEqual(M.deriveCategory('SERPC: Dump'), 'SERPCAR');
  assert.strictEqual(M.deriveCategory('PRLA_HTTPPOST Rates'), '');
});

test('CSV parser handles BOM, quotes, commas, newlines and the duplicate Developer columns', () => {
  const items = M.csvToItems(M.parseCsv(CSV));
  assert.strictEqual(items.length, 5);
  const [a, b, c, d, e] = items;
  assert.deepStrictEqual([a.id, a.itemType, a.developer, a.priority], ['20001', 'Bug', 'Dev One', 'High']);
  assert.strictEqual(a.name, 'SERPCAR FedEx REST: Sample rate issue, with comma');
  assert.strictEqual(b.name, 'ERPIS UPS REST: Sample label issue', 'collapses repeated spaces');
  assert.strictEqual(b.releaseNotes, 'Short "quoted" note');
  assert.deepStrictEqual([c.itemType, c.developer], ['User Story', 'Dev Three'], 'features use the second Developer column');
  assert.strictEqual(d.workflowStep, '2. Approved', 'trims trailing space');
  assert.strictEqual(e.releaseNotes, 'Multi\nline');
});

test('rejects files that are not an AXO export', () => {
  assert.throws(() => M.csvToItems(M.parseCsv('a,b\n1,2')), /AXO items export/);
});

function fresh(opts) {
  const g = loadGas(opts);
  g.ctx.setup();
  return g;
}

test('import adds items with derived QA defaults and is idempotent', () => {
  const { ctx, ss } = fresh();
  const s1 = ctx.importCsv(CSV, 'Tessa - QA');
  assert.deepStrictEqual([s1.added, s1.updated, s1.unchanged, s1.dropped], [5, 0, 0, 0]);
  const boot = ctx.getBootstrap();
  assert.strictEqual(boot.items.length, 5);
  const a = boot.items.find((i) => i.id === '20001');
  assert.strictEqual(a.highPriority, true, 'High priority in AXO sets the flag on first import');
  assert.strictEqual(a.axoCategory, 'SERPCAR');
  assert.strictEqual(a.status, '');
  assert.strictEqual(a.inLatestImport, true);

  const s2 = ctx.importCsv(CSV, 'Tessa - QA');
  assert.deepStrictEqual([s2.added, s2.updated, s2.unchanged], [0, 0, 5]);
  assert.strictEqual(ss.getSheetByName('Items').getLastRow(), 6, 'no duplicate rows');
});

test('re-import refreshes AXO fields but never QA fields', () => {
  const { ctx } = fresh();
  ctx.importCsv(CSV, 'x');
  ctx.updateItem('20002', { status: 'Ongoing QA', handler: 'Ley - QA', system: 'DEV 800', axoCategory: 'SERPCAR' }, 'Ley - QA');
  const changed = CSV.replace('"1. New","1","130","Medium"', '"6. Add Test Cases","8","136","High"')
    .replace(/\n"20005"[\s\S]*$/, '\n');
  const s = ctx.importCsv(changed, 'x');
  assert.deepStrictEqual([s.added, s.updated, s.dropped], [0, 1, 1]);
  const items = ctx.getBootstrap().items;
  const b = items.find((i) => i.id === '20002');
  assert.strictEqual(b.workflowStep, '6. Add Test Cases');
  assert.strictEqual(b.priority, 'High');
  assert.deepStrictEqual([b.status, b.handler, b.system, b.axoCategory], ['Ongoing QA', 'Ley - QA', 'DEV 800', 'SERPCAR']);
  assert.strictEqual(items.find((i) => i.id === '20005').inLatestImport, false, 'missing items are kept but flagged');
});

test('updateItem validates, stamps completion date and logs activity', () => {
  const { ctx, ss } = fresh();
  ctx.importCsv(CSV, 'x');
  assert.throws(() => ctx.updateItem('20001', { status: 'Nope' }, 'x'), /Unknown status/);
  assert.throws(() => ctx.updateItem('20001', { name: 'hack' }, 'x'), /cannot be edited/);
  assert.throws(() => ctx.updateItem('99999', { status: 'Done' }, 'x'), /no longer in the tracker/);

  const done = ctx.updateItem('20001', { status: 'Done' }, 'Carla - QA');
  assert.match(done.completedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(done.updatedBy, 'Carla - QA');
  const set = ctx.updateItem('20003', { completedOn: '2026-07-08', highPriority: true }, 'x');
  assert.deepStrictEqual([set.completedOn, set.highPriority], ['2026-07-08', true]);

  const log = ss.getSheetByName('Activity').dump().slice(1);
  assert.ok(log.some((r) => r[2] === '20001' && r[3] === 'Status' && r[5] === 'Done'));
  assert.ok(log.some((r) => r[2] === '20001' && r[3] === 'Date of Completion'));
  const before = log.length;
  ctx.updateItem('20001', { status: 'Done' }, 'x');
  assert.strictEqual(ss.getSheetByName('Activity').dump().length - 1, before, 'no-op edits are not logged');
});

test('notes are stored per item and counted', () => {
  const { ctx } = fresh();
  ctx.importCsv(CSV, 'x');
  ctx.addNote('20001', 'General', 'first', 'Tessa - QA');
  ctx.addNote('20001', 'Blocker', 'second', 'Tessa - QA');
  ctx.addNote('20003', 'General', 'other', 'Ley - QA');
  assert.throws(() => ctx.addNote('20001', 'General', '   ', 'x'), /Write a note/);
  const d = ctx.getItemDetail('20001');
  assert.deepStrictEqual(Array.from(d.notes, (n) => n.text), ['second', 'first'], 'newest first');
  assert.strictEqual(ctx.getBootstrap().noteCounts['20001'], 2);
});

test('addItem appends below existing rows, not below the checkbox column', () => {
  const { ctx, ss } = fresh();
  ctx.importCsv(CSV, 'x');
  ctx.addItem({ id: '30001', name: 'ERPIS manual item', itemType: 'Bug' }, 'x');
  assert.throws(() => ctx.addItem({ id: '30001', name: 'dupe' }, 'x'), /already in the tracker/);
  assert.throws(() => ctx.addItem({ id: 'abc', name: 'x' }, 'x'), /must be a number/);
  const sh = ss.getSheetByName('Items');
  assert.strictEqual(sh.get(7, 1), '30001');
  assert.strictEqual(sh.get(7, sh.dump()[0].indexOf('AXO Category') + 1), 'ERPIS');
  ctx.importCsv(CSV, 'x');
  assert.strictEqual(ctx.getBootstrap().items.length, 6);
});

test('Slack: status pings, blocker notes and import summaries', () => {
  const { ctx, slackPosts } = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' } });
  ctx.importCsv(CSV, 'Tessa - QA');
  assert.strictEqual(slackPosts.length, 1, 'import summary posted');
  assert.match(slackPosts[0].text, /5 new/);
  assert.match(slackPosts[0].blocks[0].text.text, /New high priority/);

  ctx.updateItem('20002', { status: 'Ongoing QA' }, 'x');
  assert.strictEqual(slackPosts.length, 1, 'Ongoing QA is not in the default notify list');
  ctx.updateItem('20002', { status: 'Awaiting BA/DEV' }, 'x');
  assert.strictEqual(slackPosts.length, 2);
  assert.match(slackPosts[1].blocks[0].text.text, /Ongoing QA → Awaiting BA\/DEV/);
  assert.match(slackPosts[1].blocks[0].text.text, /\?axo=20002\|AXO 20002/);

  ctx.addNote('20002', 'General', 'fyi', 'x');
  assert.strictEqual(slackPosts.length, 2);
  ctx.addNote('20002', 'Blocker', 'creds <expired>', 'x');
  assert.strictEqual(slackPosts.length, 3);
  assert.match(slackPosts[2].blocks[0].text.text, /creds &lt;expired&gt;/);

  assert.strictEqual(ctx.sendWeeklyDigest(), true);
  assert.strictEqual(slackPosts[3].blocks[0].type, 'header');
});

test('Slack is silent without a webhook', () => {
  const { ctx, slackPosts } = fresh();
  ctx.importCsv(CSV, 'x');
  ctx.updateItem('20001', { status: 'Done' }, 'x');
  assert.strictEqual(slackPosts.length, 0);
});

test('quarters: helpers, import tagging, validation', () => {
  assert.strictEqual(M.quarterLabel(2026, 1), 'Q1 2026');
  assert.strictEqual(M.quarterLabel('2026', '12'), 'Q4 2026');
  assert.ok(M.isQuarter('Q3 2026') && !M.isQuarter('Q5 2026') && !M.isQuarter('2026 Q3'));
  const { ctx } = fresh();
  assert.throws(() => ctx.importCsv(CSV, 'x', 'Q9 2026'), /Quarter must look like/);
  ctx.importCsv(CSV, 'x', 'Q3 2026');
  const boot = ctx.getBootstrap();
  assert.match(boot.currentQuarter, /^Q[1-4] \d{4}$/);
  assert.ok(boot.items.every((i) => i.quarter === 'Q3 2026'));
  ctx.importCsv(CSV, 'x', 'Q4 2026');
  assert.ok(ctx.getBootstrap().items.every((i) => i.quarter === 'Q3 2026'), 're-import keeps the original quarter');
  assert.strictEqual(ctx.updateItem('20001', { quarter: 'Q4 2026' }, 'x').quarter, 'Q4 2026');
  assert.throws(() => ctx.updateItem('20001', { quarter: 'Q4' }, 'x'), /Quarter must look like/);
  assert.strictEqual(ctx.addItem({ id: '30002', name: 'x' }, 'x').quarter, boot.currentQuarter);
});

test('BA column comes from Reported By', () => {
  const { ctx, ss } = fresh();
  ctx.importCsv(CSV, 'x');
  const header = ss.getSheetByName('Items').dump()[0];
  assert.ok(header.includes('BA') && !header.includes('Reported By'));
  assert.strictEqual(ctx.getBootstrap().items.find((i) => i.id === '20001').reportedBy, 'Reporter A');
});

function setSlackId(ss, handler, id) {
  const lists = ss.getSheetByName('Lists');
  const head = lists.dump()[0];
  const h = head.indexOf('Handler') + 1, sid = head.indexOf('Handler Slack ID') + 1;
  for (let r = 2; r <= lists.getLastRow(); r++) if (lists.get(r, h) === handler) lists.set(r, sid, id);
}

test('review points: status, note and DM to the handler', () => {
  const { ctx, ss, slackPosts, slackDms } = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks/x', SLACK_BOT_TOKEN: 'xoxb-1' } });
  ctx.importCsv(CSV, 'x');
  setSlackId(ss, 'Ley - QA', 'U0LEY');
  ctx.updateItem('20002', { handler: 'Ley - QA', status: 'Ongoing QA' }, 'Ley - QA');
  const before = slackPosts.length;
  assert.throws(() => ctx.setReviewPoints('20002', '', 'Carla - QA'), /Write a note/);
  assert.throws(() => ctx.setReviewPoints('20002', 'x', ''), /Pick your name/);
  assert.throws(() => ctx.addNote('20002', 'Review Points', 'x', 'y'), /review points form/);

  const res = ctx.setReviewPoints('20002', '1. TC3 screenshot missing\n2. Wrong system', 'Carla - QA');
  assert.strictEqual(res.item.status, 'Review Points');
  assert.strictEqual(res.note.kind, 'Review Points');
  assert.strictEqual(res.slack.via, 'dm');
  assert.strictEqual(slackDms.length, 1);
  assert.strictEqual(slackDms[0].channel, 'U0LEY');
  assert.strictEqual(slackDms[0].auth, 'Bearer xoxb-1');
  assert.match(slackDms[0].blocks[0].text.text, /TC3 screenshot missing\n>2\. Wrong system/);
  assert.match(slackDms[0].blocks[1].elements[0].text, /From Carla - QA/);
  assert.strictEqual(slackPosts.length, before, 'no duplicate channel ping for Review Points');
  assert.strictEqual(ctx.getItemDetail('20002').notes[0].kind, 'Review Points');

  // Already in Review Points: more points still DM, status unchanged
  assert.strictEqual(ctx.setReviewPoints('20002', 'one more', 'Carla - QA').slack.via, 'dm');
});

test('review points fall back to a channel @mention without a token or Slack ID', () => {
  const { ctx, ss, slackPosts, slackDms } = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks/x' } });
  ctx.importCsv(CSV, 'x');
  setSlackId(ss, 'Ley - QA', 'U0LEY');
  ctx.updateItem('20002', { handler: 'Ley - QA' }, 'x');
  const r = ctx.setReviewPoints('20002', 'fix it', 'Carla - QA');
  assert.deepStrictEqual([r.slack.via, r.slack.reason], ['channel', 'no bot token']);
  assert.strictEqual(slackDms.length, 0);
  assert.match(slackPosts[slackPosts.length - 1].blocks[0].text.text, /For <@U0LEY>/);

  const g2 = fresh();
  g2.ctx.importCsv(CSV, 'x');
  assert.strictEqual(g2.ctx.setReviewPoints('20001', 'x', 'Carla - QA').slack.via, 'none');
});

// ---------------------------------------------------------------- working days, days in status, nudges

test('working days count Tuesday to Saturday and skip the start day', () => {
  // 2026-11-10 is a Tuesday
  assert.strictEqual(M.workingDaysBetween('2026-11-10', '2026-11-10'), 0);
  assert.strictEqual(M.workingDaysBetween('2026-11-10', '2026-11-12'), 2);
  assert.strictEqual(M.workingDaysBetween('2026-11-14', '2026-11-17'), 1, 'Sat -> Tue skips Sun and Mon');
  assert.strictEqual(M.workingDaysBetween('2026-11-13', '2026-11-18'), 3);
  assert.strictEqual(M.workingDaysBetween('2026-11-12', '2026-11-10'), 0, 'never negative');
  assert.deepStrictEqual(M.quarterRange('Q4 2026'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepStrictEqual(M.quarterRange('Q1 2028'), { from: '2028-01-01', to: '2028-03-31' });
});

test('nudgeDue: only stuck nudge statuses, and not again within two working days', () => {
  const base = { status: 'Ongoing QA', statusSince: '2026-11-10T08:00:00', lastNudged: '' };
  assert.strictEqual(M.nudgeDue(base, '2026-11-11'), false, 'one working day');
  assert.strictEqual(M.nudgeDue(base, '2026-11-12'), true);
  assert.strictEqual(M.nudgeDue({ ...base, status: 'Done' }, '2026-11-20'), false);
  assert.strictEqual(M.nudgeDue({ ...base, status: '' }, '2026-11-20'), false);
  assert.strictEqual(M.nudgeDue({ ...base, lastNudged: '2026-11-12' }, '2026-11-13'), false, 'nudged yesterday');
  assert.strictEqual(M.nudgeDue({ ...base, lastNudged: '2026-11-12' }, '2026-11-14'), true, 'two working days later');
  assert.strictEqual(M.nudgeDue({ ...base, lastNudged: '2026-11-05' }, '2026-11-12'), true, 'old nudge was for an earlier status');
});

test('days in status follow the clock and restart on a status change', () => {
  const g = fresh();
  g.setNow('2026-11-10T09:00:00+08:00');
  g.ctx.importCsv(CSV, 'x');
  g.ctx.updateItem('20001', { status: 'Ongoing QA' }, 'x');
  g.ctx.updateItem('20002', { status: 'Done' }, 'x');
  g.setNow('2026-11-13T09:00:00+08:00');
  const items = g.ctx.getBootstrap().items;
  assert.strictEqual(items.find((i) => i.id === '20001').daysInStatus, 3);
  assert.strictEqual(items.find((i) => i.id === '20003').daysInStatus, 3, 'not-started AXOs count from when they arrived');
  assert.strictEqual(items.find((i) => i.id === '20002').daysInStatus, null, 'finished AXOs are not counted');
  const moved = g.ctx.updateItem('20001', { status: 'For Review' }, 'x');
  assert.strictEqual(moved.daysInStatus, 0);
  g.ctx.updateItem('20001', { handler: 'Ley - QA' }, 'x');
  g.setNow('2026-11-14T09:00:00+08:00');
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20001').daysInStatus, 1, 'other edits do not restart it');
});

test('nudges: one bot DM per handler, no repeat until two more working days', () => {
  const g = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks/x', SLACK_BOT_TOKEN: 'xoxb-1' } });
  g.setNow('2026-11-10T09:00:00+08:00');
  g.ctx.importCsv(CSV, 'x');
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  g.ctx.updateItem('20001', { handler: 'Ley - QA', status: 'Ongoing QA' }, 'x');
  g.ctx.updateItem('20002', { handler: 'Ley - QA', status: 'Awaiting BA/DEV' }, 'x');
  g.ctx.updateItem('20003', { handler: 'Carla - QA', status: 'For Review' }, 'x');
  g.ctx.updateItem('20004', { handler: 'Ley - QA', status: 'Done' }, 'x');
  const posts = g.slackPosts.length;

  g.setNow('2026-11-11T05:10:00+08:00');
  assert.strictEqual(g.ctx.sendNudges().due, 0, 'one working day is too early');

  g.setNow('2026-11-12T05:10:00+08:00');
  const r = g.ctx.sendNudges();
  assert.deepStrictEqual([r.due, r.dms, r.channel, r.failed], [3, 1, 1, 0]);
  assert.strictEqual(g.slackDms.length, 1, 'both of Ley\'s AXOs in one DM');
  assert.strictEqual(g.slackDms[0].channel, 'U0LEY');
  assert.strictEqual(g.slackDms[0].auth, 'Bearer xoxb-1');
  assert.match(g.slackDms[0].blocks[0].text.text, /2 AXOs of yours/);
  assert.match(g.slackDms[0].blocks[0].text.text, /AXO 20001[\s\S]*Ongoing QA\* for 2 working days/);
  assert.doesNotMatch(g.slackDms[0].blocks[0].text.text, /20004/, 'Done is never nudged');
  assert.strictEqual(g.slackPosts.length, posts + 1, 'For Review with no reviewer goes to the channel');
  assert.match(g.slackPosts[posts].blocks[0].text.text, /For Review, no reviewer yet[\s\S]*20003/);
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20001').lastNudged, '2026-11-12');

  g.setNow('2026-11-13T05:10:00+08:00');
  assert.strictEqual(g.ctx.sendNudges().due, 0, 'not again the next day');
  g.ctx.updateItem('20002', { status: 'Ongoing QA' }, 'x');
  g.setNow('2026-11-14T05:10:00+08:00');
  const again = g.ctx.sendNudges();
  assert.strictEqual(again.due, 2, '20001 and 20003 again; 20002 restarted its clock');
  assert.doesNotMatch(g.slackDms[1].blocks[0].text.text, /20002/);
});

test('a user token (xoxp-) is refused so DMs never come from a person', () => {
  const g = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks/x', SLACK_BOT_TOKEN: 'xoxp-user-token' } });
  g.ctx.importCsv(CSV, 'x');
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  g.ctx.updateItem('20002', { handler: 'Ley - QA' }, 'x');
  const r = g.ctx.setReviewPoints('20002', 'fix it', 'Carla - QA');
  assert.strictEqual(g.slackDms.length, 0, 'nothing sent with the user token');
  assert.strictEqual(r.slack.via, 'channel');
  assert.match(r.slack.reason, /not a bot token/);
  const boot = g.ctx.getBootstrap();
  assert.strictEqual(boot.slackDm, false);
  assert.match(boot.slackTokenIssue, /xoxb-/);
  assert.match(g.ctx.checkSlackSetup(), /BLOCKED[\s\S]*user token \(xoxp-\)/);

  const ok = fresh({ props: { SLACK_BOT_TOKEN: 'xoxb-1' } });
  assert.match(ok.ctx.checkSlackSetup(), /sent as the bot "ccqa_axo_notifier"/);
  assert.strictEqual(ok.ctx.getBootstrap().slackDm, true);
});

test('installTriggers schedules the Tuesday digest and Tue-Sat nudges', () => {
  const g = fresh({ props: { NUDGE_HOUR: '21' } });
  g.ctx.installTriggers();
  assert.deepStrictEqual(g.triggers.filter((t) => t.fn === 'sendWeeklyDigest').map((t) => [t.day, t.hour]), [['TUESDAY', 5]]);
  assert.deepStrictEqual(g.triggers.filter((t) => t.fn === 'sendNudges').map((t) => t.day),
    ['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']);
  assert.ok(g.triggers.filter((t) => t.fn === 'sendNudges').every((t) => t.hour === 21));
});

// ---------------------------------------------------------------- delete / restore

test('delete needs the passcode and moves AXOs to the Deleted tab', () => {
  const locked = fresh();
  locked.ctx.importCsv(CSV, 'x');
  assert.throws(() => locked.ctx.deleteItems(['20001'], 'anything', 'x'), /switched off/);
  assert.strictEqual(locked.ctx.getBootstrap().deleteEnabled, false);

  const g = fresh({ props: { DELETE_PASSCODE: 'open-sesame' } });
  g.ctx.importCsv(CSV, 'x');
  g.ctx.updateItem('20002', { status: 'Ongoing QA', handler: 'Ley - QA' }, 'x');
  g.ctx.addNote('20002', 'General', 'keep me', 'x');
  assert.throws(() => g.ctx.deleteItems([], 'open-sesame', 'x'), /Select at least one/);
  assert.throws(() => g.ctx.deleteItems(['20002'], 'nope', 'x'), /Wrong passcode/);
  assert.strictEqual(g.ctx.getBootstrap().items.length, 5, 'nothing deleted on a wrong passcode');

  const res = g.ctx.deleteItems(['20002', '20004', '99999'], 'open-sesame', 'Tessa - QA');
  assert.deepStrictEqual(Array.from(res.deleted), ['20002', '20004']);
  assert.deepStrictEqual(Array.from(g.ctx.getBootstrap().items, (i) => i.id).sort(), ['20001', '20003', '20005']);
  const del = g.ss.getSheetByName('Deleted').dump();
  assert.strictEqual(del.length, 3);
  assert.strictEqual(del[1][del[0].indexOf('Status')], 'Ongoing QA', 'QA fields are kept in the Deleted tab');
  assert.strictEqual(del[1][del[0].indexOf('Deleted By')], 'Tessa - QA');
  assert.ok(g.ss.getSheetByName('Activity').dump().some((r) => r[3] === 'Delete' && /2 AXOs moved to Deleted: 20002, 20004/.test(r[5])));
  // the remaining rows are intact and still editable
  assert.strictEqual(g.ctx.updateItem('20005', { status: 'Done' }, 'x').status, 'Done');
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20001').highPriority, true);
});

test('five wrong passcodes lock deleting', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  g.ctx.importCsv(CSV, 'x');
  for (let i = 0; i < 5; i++) assert.throws(() => g.ctx.deleteItems(['20001'], 'bad', 'x'), /Wrong passcode/);
  assert.throws(() => g.ctx.deleteItems(['20001'], 'pw', 'x'), /Too many wrong passcodes/);
});

test('deleted AXOs stay out on re-import unless asked for, and can be restored', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  g.ctx.importCsv(CSV, 'x');
  g.ctx.updateItem('20002', { status: 'For Review', handler: 'Ley - QA' }, 'x');
  g.ctx.addNote('20002', 'General', 'still here', 'x');
  g.ctx.deleteItems(['20002', '20003'], 'pw', 'x');

  const again = g.ctx.importCsv(CSV, 'x');
  assert.deepStrictEqual([again.added, again.skippedDeleted, again.unchanged], [0, 2, 3]);
  assert.strictEqual(g.ctx.getBootstrap().items.length, 3);

  const restored = g.ctx.restoreItems_(['20002'], 'x');
  assert.deepStrictEqual(Array.from(restored.restored), ['20002']);
  const back = g.ctx.getBootstrap().items.find((i) => i.id === '20002');
  assert.deepStrictEqual([back.status, back.handler], ['For Review', 'Ley - QA'], 'comes back as it was');
  assert.strictEqual(g.ctx.getItemDetail('20002').notes[0].text, 'still here', 'notes come back with it');
  assert.strictEqual(g.ss.getSheetByName('Deleted').dump().length, 2, 'only 20003 is left in Deleted');

  const forced = g.ctx.importCsv(CSV, 'x', '', true);
  assert.deepStrictEqual([forced.added, forced.skippedDeleted], [1, 0]);
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20003').status, '', 're-added as new');
  assert.strictEqual(g.ctx.importCsv(CSV, 'x').skippedDeleted, 0, 'now live again, so no longer skipped');
});

test('delete ALL, then import again into the emptied sheet', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  g.ctx.importCsv(CSV, 'x');
  const ids = g.ctx.getBootstrap().items.map((i) => i.id);
  assert.strictEqual(g.ctx.deleteItems(ids, 'pw', 'x').deleted.length, 5);
  assert.strictEqual(g.ctx.getBootstrap().items.length, 0);
  assert.strictEqual(g.ss.getSheetByName('Items').getLastRow(), 1, 'only the header is left');
  const res = g.ctx.importCsv(CSV, 'x', '', true);
  assert.strictEqual(res.added, 5);
  assert.strictEqual(g.ctx.addItem({ id: '30009', name: 'ERPIS extra' }, 'x').id, '30009');
  assert.strictEqual(g.ctx.getBootstrap().items.length, 6);
});

test('a sheet that shrank still takes a large import', () => {
  const g = fresh();
  const items = g.ss.getSheetByName('Items');
  items.maxRows = 3;
  const head = CSV.split('\n')[0];
  let big = head + '\n';
  for (let i = 0; i < 700; i++) big += `"${40000 + i}","defects","SERPCAR bulk ${i}","1. New","1","130","Medium","2","3","","","Dev","","BA","1",\n`;
  assert.strictEqual(g.ctx.importCsv(big, 'x').added, 700);
  assert.strictEqual(g.ctx.getBootstrap().items.length, 700);
});

// ---------------------------------------------------------------- upgrade from the earlier sheet layout

test('an existing sheet is upgraded on first load without losing data', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  g.setNow('2026-11-03T09:00:00+08:00');
  g.ctx.importCsv(CSV, 'x');
  g.ctx.updateItem('20002', { status: 'Ongoing QA', handler: 'Ley - QA' }, 'x');
  g.ctx.updateItem('20003', { highPriority: true }, 'x');
  g.ctx.updateItem('20003', { highPriority: false }, 'x');
  // Put the sheet back to how the previous version left it: no new columns, no Deleted
  // tab, High Priority unticked by the old checkbox bug, Lists without the email columns.
  const items = g.ss.getSheetByName('Items');
  const head = items.dump()[0];
  ['Status Since', 'Last Nudged'].forEach((h) => {
    const c = head.indexOf(h) + 1;
    for (let r = 1; r <= items.getLastRow(); r++) items.set(r, c, '');
  });
  g.setCell('20001', 'High Priority', false);
  ['20001', '20002', '20003', '20004', '20005'].forEach((id) => g.setCell(id, 'In Latest Import', false));
  delete g.ss.sheets.Deleted;
  const lists = g.ss.getSheetByName('Lists');
  const lh = lists.dump()[0];
  ['Email To', 'Email CC'].forEach((h) => lists.set(1, lh.indexOf(h) + 1, ''));
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  delete g.props.SCHEMA_VERSION;

  g.setNow('2026-11-06T09:00:00+08:00');
  const boot = g.ctx.getBootstrap();
  assert.strictEqual(g.props.SCHEMA_VERSION, '6');
  assert.ok(g.ss.getSheetByName('Deleted'), 'Deleted tab created');
  const newLists = lists.dump()[0];
  assert.ok(newLists.includes('Email To') && newLists.includes('Email CC'));
  assert.deepStrictEqual(Array.from(boot.lists.slackHandlers), ['Ley - QA'], 'existing Slack IDs survive');
  const by = (id) => boot.items.find((i) => i.id === id);
  assert.strictEqual(boot.items.length, 5);
  assert.deepStrictEqual([by('20002').status, by('20002').handler], ['Ongoing QA', 'Ley - QA']);
  assert.strictEqual(by('20002').statusSince.slice(0, 10), '2026-11-03', 'taken from the Activity log');
  assert.strictEqual(by('20002').daysInStatus, 3);
  assert.strictEqual(by('20001').highPriority, true, 'High Priority put back for High-priority AXOs');
  assert.strictEqual(by('20003').highPriority, false, 'but not where someone unticked it by hand');
  assert.ok(boot.items.every((i) => i.inLatestImport), '"In Latest Import" put back for the last import');
});

// ---------------------------------------------------------------- report

test('report: snapshot, workload and period activity', () => {
  const g = fresh();
  g.setNow('2026-11-03T09:00:00+08:00');
  g.ctx.importCsv(CSV, 'x', 'Q4 2026');
  g.ctx.addItem({ id: '30001', name: 'ERPIS other quarter', quarter: 'Q3 2026' }, 'x');
  g.ctx.updateItem('20001', { handler: 'Ley - QA', status: 'Ongoing QA' }, 'Ley - QA');
  g.ctx.updateItem('20002', { handler: 'Ley - QA', status: 'For Review' }, 'Ley - QA');
  g.ctx.updateItem('20003', { handler: 'Carla - QA', status: 'Done' }, 'Carla - QA');
  g.ctx.updateItem('20005', { handler: 'Carla - QA', status: 'Withdraw' }, 'Carla - QA');
  g.ctx.setReviewPoints('20002', 'screenshot missing', 'Carla - QA');
  g.ctx.addNote('20001', 'Blocker', 'creds <expired>', 'Ley - QA');
  g.setNow('2026-11-07T09:00:00+08:00');

  const d = g.ctx.reportData_({ quarter: 'Q4 2026', from: '2026-11-01', to: '2026-11-07', actorName: 'Tessa - QA <t@x.com>' });
  assert.strictEqual(d.total, 5, 'the Q3 AXO is out of scope');
  assert.deepStrictEqual({ ...d.groups }, { 'Not Started': 1, 'In Progress': 2, 'Completed': 1, 'Discarded': 1 });
  assert.strictEqual(d.completionRate, 25, '1 completed of 4 not discarded');
  assert.strictEqual(d.options.by, 'Tessa - QA');
  const ley = d.workload.find((w) => w.name === 'Ley - QA'), carla = d.workload.find((w) => w.name === 'Carla - QA');
  assert.deepStrictEqual([ley.total, ley['In Progress'], ley.pointsReceived, ley.reviewsGiven], [2, 2, 1, 0]);
  assert.deepStrictEqual([carla.total, carla['Completed'], carla['Discarded'], carla.completedInPeriod, carla.reviewsGiven], [2, 1, 1, 1, 1]);
  assert.strictEqual(d.workload[d.workload.length - 1].name, 'Unassigned');
  assert.deepStrictEqual({ ...d.activity }, { completed: 1, statusChanges: 5, reviewPoints: 1, blockers: 1, backToDev: 0 });
  assert.deepStrictEqual(Array.from(d.reworked, (x) => [x.item.id, x.rounds, x.back]), [['20002', 1, 0]]);
  assert.match(g.ctx.buildReport({ quarter: 'Q4 2026' }).html, /Most reworked AXOs/);
  assert.deepStrictEqual(Array.from(d.stuck, (i) => i.id).sort(), ['20001', '20002'], 'in one status for 2+ working days');
  assert.deepStrictEqual(Array.from(d.hpOpen, (i) => i.id), ['20001']);
  const rp = d.statusRows.find((r) => r.name === 'Review Points');
  assert.deepStrictEqual([rp.bugs, rp.stories, rp.total], [1, 0, 1]);

  const out = g.ctx.buildReport({ quarter: 'Q4 2026', from: '2026-11-01', to: '2026-11-07', actorName: 'Tessa - QA' });
  assert.match(out.html, /AXO Monitoring Report/);
  assert.match(out.html, /Q4 2026 &middot; activity from Nov 1, 2026 to Nov 7, 2026/);
  assert.match(out.html, /creds &lt;expired&gt;/, 'note text is escaped');
  assert.match(out.html, /All AXOs in Q4 2026 \(5\)/);
  assert.strictEqual(out.filename, 'CCQA-AXO-Report_Q4-2026_2026-11-01_to_2026-11-07.pdf');
  assert.doesNotMatch(g.ctx.buildReport({ quarter: 'Q4 2026', includeList: false }).html, /All AXOs in Q4 2026/);

  // Nothing completed outside the period; all quarters widen the scope
  assert.strictEqual(g.ctx.reportData_({ quarter: 'Q4 2026', from: '2026-10-01', to: '2026-10-31' }).activity.completed, 0);
  assert.strictEqual(g.ctx.reportData_({ quarter: '' }).total, 6);
  assert.deepStrictEqual([g.ctx.reportData_({ quarter: 'Q4 2026' }).options.from, g.ctx.reportData_({ quarter: 'Q4 2026' }).options.to],
    ['2026-10-01', '2026-12-31'], 'defaults to the whole quarter');
  assert.throws(() => g.ctx.reportData_({ quarter: 'Q9 2026' }), /Quarter must look like/);
  assert.throws(() => g.ctx.reportData_({ from: '2026-11-07', to: '2026-11-01' }), /start date is after/);

  const pdf = g.ctx.reportPdf({ quarter: 'Q4 2026' });
  assert.match(pdf.filename, /\.pdf$/);
  assert.match(Buffer.from(pdf.base64, 'base64').toString(), /^%PDF-fake[\s\S]*AXO Monitoring Report/);
});

test('bootstrap carries what the new screens need', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  g.ctx.importCsv(CSV, 'x');
  const lists = g.ss.getSheetByName('Lists');
  const head = lists.dump()[0];
  lists.set(2, head.indexOf('Email To') + 1, 'kath@example.com');
  lists.set(3, head.indexOf('Email To') + 1, 'jhopet@example.com');
  lists.set(2, head.indexOf('Email CC') + 1, 'ccqa@example.com');
  g.ctx.updateItem('20001', { handler: 'Ley - QA' }, 'x');
  g.ctx.setReviewPoints('20001', 'p', 'Carla - QA');
  const boot = g.ctx.getBootstrap();
  assert.deepStrictEqual(Array.from(boot.emailTo), ['kath@example.com', 'jhopet@example.com']);
  assert.deepStrictEqual(Array.from(boot.emailCc), ['ccqa@example.com']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(boot.reviews)), [{ id: '20001', by: 'Carla - QA' }]);
  assert.strictEqual(boot.deleteEnabled, true);
  assert.match(boot.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(boot.appUrl, /\/exec$/);
});

test('every change needs a name, checked on the server too', () => {
  const g = fresh({ props: { DELETE_PASSCODE: 'pw' } });
  const need = /Pick your name in the top bar/;
  assert.throws(() => g.ctx.importCsv(CSV, ''), need);
  assert.throws(() => g.ctx.importCsv(CSV, '   '), need);
  g.ctx.importCsv(CSV, 'Tessa - QA');
  assert.throws(() => g.ctx.updateItem('20001', { status: 'Done' }, ''), need);
  assert.throws(() => g.ctx.updateItem('20001', { status: 'Done' }), need, 'missing argument');
  assert.throws(() => g.ctx.addItem({ id: '30001', name: 'x' }, ''), need);
  assert.throws(() => g.ctx.addNote('20001', 'General', 'hi', ''), need);
  assert.throws(() => g.ctx.setReviewPoints('20001', 'p', ''), /Pick your name/);
  assert.throws(() => g.ctx.deleteItems(['20001'], 'pw', ''), need);
  const item = g.ctx.getBootstrap().items.find((i) => i.id === '20001');
  assert.strictEqual(item.status, '', 'nothing was changed');
  assert.strictEqual(g.ctx.getBootstrap().items.length, 5, 'nothing was added or deleted');
});

test('DEV/SED comment boxes are retired: text moves to notes once, kinds are gone', () => {
  const g = fresh();
  g.ctx.importCsv(CSV, 'x');
  assert.throws(() => g.ctx.updateItem('20001', { commentDev: 'x' }, 'x'), /cannot be edited/);
  assert.throws(() => g.ctx.addNote('20001', 'DEV', 'x', 'x'), /no longer used/);
  assert.deepStrictEqual(Array.from(g.ctx.getBootstrap().lists.noteKinds), ['General', 'Blocker']);

  // A sheet from the earlier version: comments in the old columns, DEV/SED still in Lists.
  g.setCell('20002', 'Comment/Note (DEV)', 'TC1-4 passed in DEV 800');
  g.setCell('20002', 'Comment/Note (SED)', 'Waiting on SED transport');
  g.setCell('20004', 'Comment/Note (SED)', 'SED passed');
  const lists = g.ss.getSheetByName('Lists');
  const kc = lists.dump()[0].indexOf('Note Kind') + 1;
  ['General', 'DEV', 'SED', 'Blocker'].forEach((k, i) => lists.set(i + 2, kc, k));
  delete g.props.COMMENTS_MIGRATED;
  g.props.SCHEMA_VERSION = '3';

  const boot = g.ctx.getBootstrap();
  assert.deepStrictEqual(Array.from(boot.lists.noteKinds), ['General', 'Blocker'], 'DEV/SED hidden even if still in Lists');
  const n2 = g.ctx.getItemDetail('20002').notes.map((n) => [n.kind, n.text]).sort();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(n2)), [['DEV', 'TC1-4 passed in DEV 800'], ['SED', 'Waiting on SED transport']]);
  assert.strictEqual(g.ctx.getItemDetail('20004').notes.length, 1);
  assert.strictEqual(boot.noteCounts['20002'], 2);
  assert.strictEqual(g.props.COMMENTS_MIGRATED, '3');

  g.props.SCHEMA_VERSION = '3';
  g.ctx.getBootstrap();
  assert.strictEqual(g.ctx.getItemDetail('20002').notes.length, 2, 'not copied twice');
});

test('release: per AXO, stored without the category prefix, settable in bulk', () => {
  assert.strictEqual(M.cleanRelease(' ERPIS 5.4 '), '5.4');
  assert.strictEqual(M.cleanRelease('SERPCAR 3.8 Release'), '3.8');
  assert.strictEqual(M.cleanRelease('5.4'), '5.4');
  const g = fresh();
  g.ctx.importCsv(CSV, 'x');
  assert.strictEqual(g.ctx.getBootstrap().items[0].release, '');
  assert.strictEqual(g.ctx.updateItem('20002', { release: 'ERPIS 5.4' }, 'x').release, '5.4');
  const res = g.ctx.updateItems(['20001', '20003'], { release: '3.8' }, 'Tessa - QA');
  assert.deepStrictEqual(Array.from(res, (i) => i.release), ['3.8', '3.8']);
  assert.throws(() => g.ctx.updateItems([], { release: '1' }, 'x'), /Select at least one/);
  assert.throws(() => g.ctx.updateItems(['20001'], { release: '1' }, ''), /Pick your name/);
  assert.ok(g.ss.getSheetByName('Activity').dump().some((r) => r[2] === '20001' && r[3] === 'Release' && r[5] === '3.8'));
  assert.strictEqual(g.ctx.addItem({ id: '30001', name: 'ERPIS x', release: 'ERPIS 5.5' }, 'x').release, '5.5');
  assert.deepStrictEqual(g.ss.getSheetByName('Items').dump()[0].slice(-2), ['Release', 'Reviewer'], 'new columns go at the end');
});

// ---------------------------------------------------------------- reviewer, bulk status, rework

test('reviewer: claimed by another QA, never the handler; handler is told', () => {
  const g = fresh({ props: { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_WEBHOOK_URL: 'https://hooks/x' } });
  g.ctx.importCsv(CSV, 'x');
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  g.ctx.updateItem('20001', { handler: 'Ley - QA', status: 'For Review' }, 'Ley - QA');
  assert.throws(() => g.ctx.updateItem('20001', { reviewer: 'Ley - QA' }, 'Ley - QA'), /someone else has to review it/);
  const dms = g.slackDms.length;
  const it = g.ctx.updateItem('20001', { reviewer: 'Carla - QA' }, 'Carla - QA');
  assert.strictEqual(it.reviewer, 'Carla - QA');
  assert.strictEqual(g.slackDms.length, dms + 1);
  assert.strictEqual(g.slackDms[dms].channel, 'U0LEY');
  assert.match(g.slackDms[dms].blocks[0].text.text, /Carla - QA\* is reviewing/);
  assert.throws(() => g.ctx.updateItem('20001', { handler: 'Carla - QA' }, 'x'), /someone else has to review it/, 'nor reassigned to the reviewer');
  assert.strictEqual(g.ctx.updateItem('20001', { reviewer: '' }, 'Carla - QA').reviewer, '', 'can give it back');
});

test('review points make the sender the reviewer, with only the points DM', () => {
  const g = fresh({ props: { SLACK_BOT_TOKEN: 'xoxb-1' } });
  g.ctx.importCsv(CSV, 'x');
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  g.ctx.updateItem('20002', { handler: 'Ley - QA', status: 'For Review' }, 'x');
  g.ctx.setReviewPoints('20002', 'fix TC3', 'Carla - QA');
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20002').reviewer, 'Carla - QA');
  assert.strictEqual(g.slackDms.length, 1);
  assert.match(g.slackDms[0].blocks[0].text.text, /Review points/);
  // an existing reviewer is kept when someone else adds points
  g.ctx.setReviewPoints('20002', 'one more', 'AJ - QA');
  assert.strictEqual(g.ctx.getBootstrap().items.find((i) => i.id === '20002').reviewer, 'Carla - QA');
});

test('nudges for For Review go to the reviewer', () => {
  const g = fresh({ props: { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_WEBHOOK_URL: 'https://hooks/x' } });
  g.setNow('2026-11-10T09:00:00+08:00');
  g.ctx.importCsv(CSV, 'x');
  setSlackId(g.ss, 'Ley - QA', 'U0LEY');
  setSlackId(g.ss, 'Carla - QA', 'U0CARLA');
  g.ctx.updateItem('20001', { handler: 'Ley - QA', status: 'For Review', reviewer: 'Carla - QA' }, 'x');
  g.ctx.updateItem('20002', { handler: 'Ley - QA', status: 'Ongoing QA' }, 'x');
  const before = g.slackDms.length;
  g.setNow('2026-11-12T05:10:00+08:00');
  const r = g.ctx.sendNudges();
  assert.deepStrictEqual([r.due, r.dms], [2, 2]);
  const sent = g.slackDms.slice(before);
  const carla = sent.find((d) => d.channel === 'U0CARLA'), ley = sent.find((d) => d.channel === 'U0LEY');
  assert.match(carla.blocks[0].text.text, /20001[\s\S]*you are the reviewer/);
  assert.match(ley.blocks[0].text.text, /20002/);
  assert.doesNotMatch(ley.blocks[0].text.text, /20001/, 'the handler is not nudged while it waits on the reviewer');
});

test('bulk status: one Slack summary, Review Points refused', () => {
  const g = fresh({ props: { SLACK_WEBHOOK_URL: 'https://hooks/x' } });
  g.ctx.importCsv(CSV, 'x');
  const posts = g.slackPosts.length;
  assert.throws(() => g.ctx.updateItems(['20001'], { status: 'Review Points' }, 'x'), /one AXO at a time/);
  g.ctx.updateItem('20003', { status: 'Done' }, 'x');
  const after1 = g.slackPosts.length;
  const res = g.ctx.updateItems(['20001', '20002', '20003'], { status: 'Done' }, 'Tessa - QA');
  assert.deepStrictEqual(Array.from(res, (i) => i.status), ['Done', 'Done', 'Done']);
  assert.ok(res.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.completedOn)), 'completion date stamped');
  assert.strictEqual(g.slackPosts.length, after1 + 1, 'one summary post');
  assert.match(g.slackPosts[after1].blocks[0].text.text, /^\*2 AXOs → Done\*/, 'only the ones that changed');
  assert.strictEqual(after1, posts + 1);
  g.ctx.updateItems(['20004'], { status: 'Ongoing QA' }, 'x');
  assert.strictEqual(g.slackPosts.length, after1 + 1, 'no post for statuses outside the notify list');
});

test('rework: review rounds and trips back to BA/DEV', () => {
  assert.deepStrictEqual(M.reworkCounts([
    [0, 'a', '1', 'Status', 'Ongoing QA', 'Ongoing BA/DEV'],
    [0, 'a', '1', 'Status', 'Not started', 'Ongoing BA/DEV'],
    [0, 'a', '1', 'Status', 'Awaiting BA/DEV', 'Ongoing BA/DEV'],
    [0, 'a', '1', 'Status', 'For Review', 'Ongoing BA/DEV'],
    [0, 'a', '2', 'Workflow Step', '6. Add test cases', '4.A Rework'],
    [0, 'a', '2', 'Workflow Step', '4.A Rework', '4.A Rework again']
  ], [['n', '1', 'Review Points'], ['n', '1', 'Review Points'], ['n', '2', 'General']]),
  { 1: { rounds: 2, back: 2 }, 2: { rounds: 0, back: 1 } });

  const g = fresh();
  g.ctx.importCsv(CSV, 'x');
  g.ctx.updateItem('20001', { handler: 'Ley - QA', status: 'Ongoing QA' }, 'x');
  g.ctx.updateItem('20001', { status: 'Ongoing BA/DEV' }, 'x');
  g.ctx.updateItem('20001', { status: 'For Review' }, 'x');
  g.ctx.setReviewPoints('20001', 'fix', 'Carla - QA');
  const rw = g.ctx.getBootstrap().rework;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rw['20001'])), { rounds: 1, back: 1 });
  assert.strictEqual(rw['20002'], undefined);
});
