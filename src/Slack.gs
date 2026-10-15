/**
 * Slack notifications through an Incoming Webhook.
 *
 * Script properties (Project Settings > Script properties):
 *   SLACK_WEBHOOK_URL       channel posts; leave unset to turn channel posts off
 *   SLACK_BOT_TOKEN         xoxb- token with chat:write; needed to DM review points
 *                           to the handler (falls back to a channel @mention without it)
 *   SLACK_NOTIFY_STATUSES   optional, comma-separated statuses that ping the channel
 *                           (default: Awaiting BA/DEV, For Review, Done)
 *   APP_URL                 optional, the /exec URL linked from messages
 *
 * Map handlers to Slack member IDs in the Lists sheet ("Handler Slack ID" column,
 * same row as the handler) so pings @mention the right person.
 */

// Review Points is not here: those go to the handler as a DM with the points attached.
var DEFAULT_NOTIFY_STATUSES = ['Awaiting BA/DEV', 'For Review', 'Done'];

function slackConfig_() {
  var p = PropertiesService.getScriptProperties();
  var statuses = (p.getProperty('SLACK_NOTIFY_STATUSES') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  var appUrl = p.getProperty('APP_URL');
  if (!appUrl) { try { appUrl = ScriptApp.getService().getUrl(); } catch (e) { appUrl = ''; } }
  return { webhook: p.getProperty('SLACK_WEBHOOK_URL'), statuses: statuses.length ? statuses : DEFAULT_NOTIFY_STATUSES, appUrl: appUrl };
}

function slackPost_(payload) {
  var cfg = slackConfig_();
  if (!cfg.webhook) return false;
  var res = UrlFetchApp.fetch(cfg.webhook, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    console.warn('Slack returned ' + res.getResponseCode() + ': ' + res.getContentText());
    return false;
  }
  return true;
}

/** Direct message through the Slack Web API. channel can be a member ID (U…). */
function slackDm_(memberId, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'no bot token' };
  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post', contentType: 'application/json; charset=utf-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(Object.assign({ channel: memberId, unfurl_links: false }, payload))
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (!body.ok) console.warn('Slack DM failed: ' + res.getContentText());
  return { ok: !!body.ok, error: body.error || '' };
}

/** Review points go to the handler's DM; without a token or member ID, @mention in the channel. */
function sendReviewPoints_(item, note, reviewerName) {
  var memberId = (readLists_().slackIds || {})[item.handler];
  var quoted = '>' + esc_(note.text).slice(0, 2800).replace(/\n/g, '\n>');
  var head = ':mag: *Review points* on ' + itemLink_(item) + '  ' + esc_(item.name);
  var ctx = { type: 'context', elements: [{ type: 'mrkdwn', text: 'From ' + esc_(reviewerName) + ' · ' + esc_(item.quarter || '') }] };
  var fallback = 'Review points on AXO ' + item.id + ' from ' + reviewerName + ': ' + note.text.slice(0, 200);
  if (memberId) {
    var dm = slackDm_(memberId, { text: fallback, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: head + '\n' + quoted } }, ctx] });
    if (dm.ok) return { via: 'dm', to: item.handler };
    if (dm.error !== 'no bot token') console.warn('Falling back to channel: ' + dm.error);
  }
  var posted = slackPost_({ text: fallback, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: head + '\nFor ' + who_(item.handler) + '\n' + quoted } }, ctx] });
  if (posted) return { via: 'channel', to: item.handler, reason: !item.handler ? 'no handler' : !memberId ? 'no Slack ID for handler' : 'no bot token' };
  return { via: 'none', reason: 'Slack is not set up' };
}

function esc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function who_(handler) {
  var ids = readLists_().slackIds || {};
  return ids[handler] ? '<@' + ids[handler] + '>' : esc_(handler || 'Unassigned');
}

function itemLink_(item) {
  var cfg = slackConfig_();
  var label = 'AXO ' + item.id;
  return cfg.appUrl ? '<' + cfg.appUrl + '?axo=' + encodeURIComponent(item.id) + '|' + label + '>' : label;
}

/** Called after updateItem() writes at least one change. */
function onItemChanged_(before, after, actorName) {
  var cfg = slackConfig_();
  if (!cfg.webhook) return;
  var lines = [];
  if (after.status !== before.status && after.status !== 'Review Points' && cfg.statuses.indexOf(after.status) >= 0) {
    lines.push('*' + esc_(before.status || 'Not started') + ' → ' + esc_(after.status) + '*');
  }
  if (after.highPriority && !before.highPriority) lines.push('*Flagged high priority*');
  if (after.handler !== before.handler && after.handler) lines.push('Assigned to ' + who_(after.handler));
  if (!lines.length) return;
  var ctx = [after.itemType, after.axoCategory, after.system, 'Handler: ' + (after.handler || 'none')].filter(String).join(' · ');
  slackPost_({
    text: 'AXO ' + after.id + ': ' + lines.join(', ').replace(/\*/g, ''),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: itemLink_(after) + '  ' + esc_(after.name) + '\n' + lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: esc_(ctx) + ' · by ' + esc_(actorName || 'someone') }] }
    ]
  });
}

/** Blocker notes always ping; other notes stay in the tracker. */
function onNoteAdded_(item, note, actorName) {
  if (note.kind !== 'Blocker') return;
  slackPost_({
    text: 'Blocker on AXO ' + item.id + ': ' + note.text.slice(0, 200),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':no_entry: *Blocker* on ' + itemLink_(item) + '  ' + esc_(item.name) + '\n>' + esc_(note.text).slice(0, 2800).replace(/\n/g, '\n>') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Handler: ' + who_(item.handler) + ' · noted by ' + esc_(actorName || 'someone') }] }
    ]
  });
}

function onImported_(summary, actorName) {
  if (!summary.added && !summary.dropped) return;
  var text = '*AXO import* by ' + esc_(actorName || 'someone') + ': ' + summary.added + ' new, ' + summary.updated +
    ' updated, ' + summary.dropped + ' no longer in the export.';
  if (summary.newHighPriority.length) {
    text += '\nNew high priority:\n' + summary.newHighPriority.slice(0, 15).map(function (i) {
      return '• ' + itemLink_(i) + '  ' + esc_(i.name);
    }).join('\n');
  }
  slackPost_({ text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text } }] });
}

/** Weekly summary, Tuesdays 5 AM. Install with installTriggers(). */
function sendWeeklyDigest() {
  var items = readItems_().rows.map(function (r) { return rowToItem_(r.values); });
  var groups = { 'Not Started': 0, 'In Progress': 0, 'Completed': 0, 'Discarded': 0 };
  var byStatus = {};
  items.forEach(function (i) {
    groups[statusGroup(i.status)]++;
    var s = i.status || 'Not started';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  var open = items.filter(function (i) { var g = statusGroup(i.status); return g === 'Not Started' || g === 'In Progress'; });
  var hpUnassigned = open.filter(function (i) { return i.highPriority && !i.handler; });
  var staleCutoff = new Date(Date.now() - 2 * 864e5);
  var waiting = open.filter(function (i) {
    return i.status === 'Awaiting BA/DEV' && i.updatedAt && new Date(i.updatedAt) < staleCutoff;
  });
  var list = function (arr) {
    return arr.slice(0, 10).map(function (i) { return '• ' + itemLink_(i) + '  ' + esc_(i.name); }).join('\n') +
      (arr.length > 10 ? '\n…and ' + (arr.length - 10) + ' more' : '');
  };
  var blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'CCQA AXO weekly digest · ' + Utilities.formatDate(new Date(), TZ, 'EEE d MMM') } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Not started*\n' + groups['Not Started'] },
      { type: 'mrkdwn', text: '*In progress*\n' + groups['In Progress'] },
      { type: 'mrkdwn', text: '*Completed*\n' + groups['Completed'] },
      { type: 'mrkdwn', text: '*Discarded*\n' + groups['Discarded'] }
    ] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: Object.keys(byStatus).sort().map(function (k) { return esc_(k) + ': ' + byStatus[k]; }).join(' · ') }] }
  ];
  if (hpUnassigned.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*High priority, no handler (' + hpUnassigned.length + ')*\n' + list(hpUnassigned) } });
  if (waiting.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Awaiting BA/DEV for 2+ days (' + waiting.length + ')*\n' + list(waiting) } });
  var cfg = slackConfig_();
  if (cfg.appUrl) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open tracker' }, url: cfg.appUrl }] });
  return slackPost_({ text: 'CCQA AXO weekly digest: ' + open.length + ' open items', blocks: blocks });
}

/**
 * Every Tuesday at 5 AM in the script time zone (Asia/Manila). Apps Script runs an
 * hourly trigger at some point inside that hour, so expect it between 5:00 and 6:00.
 * Re-running replaces any earlier digest trigger, including the old daily one.
 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendWeeklyDigest' || fn === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(5).create();
  return 'Weekly digest scheduled for Tuesdays at 5 AM (' + TZ + ')';
}

function testSlack() {
  var ok = slackPost_({ text: 'CCQA AXO Tracker is connected to this channel.' });
  if (!ok) throw new Error('Slack did not accept the message. Check SLACK_WEBHOOK_URL in Script properties.');
  return 'Sent';
}
