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
  ctx.updateItem('20002', { status: 'Ongoing QA', handler: 'Ley - QA', commentDev: 'retest pending', axoCategory: 'SERPCAR' }, 'Ley - QA');
  const changed = CSV.replace('"1. New","1","130","Medium"', '"6. Add Test Cases","8","136","High"')
    .replace(/\n"20005"[\s\S]*$/, '\n');
  const s = ctx.importCsv(changed, 'x');
  assert.deepStrictEqual([s.added, s.updated, s.dropped], [0, 1, 1]);
  const items = ctx.getBootstrap().items;
  const b = items.find((i) => i.id === '20002');
  assert.strictEqual(b.workflowStep, '6. Add Test Cases');
  assert.strictEqual(b.priority, 'High');
  assert.deepStrictEqual([b.status, b.handler, b.commentDev, b.axoCategory], ['Ongoing QA', 'Ley - QA', 'retest pending', 'SERPCAR']);
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
  ctx.addNote('20001', 'DEV', 'second', 'Tessa - QA');
  ctx.addNote('20003', 'SED', 'other', 'Ley - QA');
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
  assert.strictEqual(sh.get(7, 10), 'ERPIS');
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

  assert.strictEqual(ctx.sendDailyDigest(), true);
  assert.strictEqual(slackPosts[3].blocks[0].type, 'header');
});

test('Slack is silent without a webhook', () => {
  const { ctx, slackPosts } = fresh();
  ctx.importCsv(CSV, 'x');
  ctx.updateItem('20001', { status: 'Done' }, 'x');
  assert.strictEqual(slackPosts.length, 0);
});
