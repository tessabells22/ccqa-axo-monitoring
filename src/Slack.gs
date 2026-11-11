/**
 * Slack notifications: channel posts through an Incoming Webhook, direct messages
 * through the app's bot token.
 *
 * Script properties (Project Settings > Script properties):
 *   SLACK_WEBHOOK_URL       channel posts; leave unset to turn channel posts off
 *   SLACK_BOT_TOKEN         the app's Bot User OAuth Token (starts with xoxb-) with chat:write.
 *                           Needed for DMs: review points and 2-day nudges. A user token
 *                           (xoxp-) is refused, because Slack would send as that person.
 *   NUDGE_HOUR              optional, hour of day (0-23, script time zone) for nudges; default 5
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

var NOT_BOT_TOKEN = 'SLACK_BOT_TOKEN is not a bot token (it must start with xoxb-)';

/**
 * Direct message through the Slack Web API. channel can be a member ID (U…).
 * Only a bot token is accepted: with a user token (xoxp-) Slack sends the DM as
 * the person who installed the app instead of as the app.
 */
function slackDm_(memberId, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'no bot token' };
  if (!/^xoxb-/.test(token)) return { ok: false, error: NOT_BOT_TOKEN };
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
    var dmError = dm.error;
  }
  var posted = slackPost_({ text: fallback, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: head + '\nFor ' + who_(item.handler) + '\n' + quoted } }, ctx] });
  var why = !item.handler ? 'no handler' : !memberId ? 'no Slack ID for handler' : dmError === 'no bot token' ? 'no bot token' :
    dmError === NOT_BOT_TOKEN ? NOT_BOT_TOKEN : 'Slack refused the DM: ' + dmError;
  if (posted) return { via: 'channel', to: item.handler, reason: why };
  return { via: 'none', reason: dmError === NOT_BOT_TOKEN ? NOT_BOT_TOKEN : 'Slack is not set up' };
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
  var waiting = open.filter(function (i) {
    return i.status === 'Awaiting BA/DEV' && i.daysInStatus >= NUDGE_AFTER_DAYS;
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
  if (waiting.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Awaiting BA/DEV for ' + NUDGE_AFTER_DAYS + '+ working days (' + waiting.length + ')*\n' + list(waiting) } });
  var cfg = slackConfig_();
  if (cfg.appUrl) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open tracker' }, url: cfg.appUrl }] });
  return slackPost_({ text: 'CCQA AXO weekly digest: ' + open.length + ' open items', blocks: blocks });
}

/**
 * Nudges handlers whose AXOs have sat in the same status for NUDGE_AFTER_DAYS+ working
 * days. One DM per handler, from the bot, listing all of their stuck AXOs. A handler
 * with no Slack ID (or no bot token) is covered by one post in the team channel.
 * Each AXO is nudged again only after another NUDGE_AFTER_DAYS working days.
 */
function sendNudges() {
  var today = today_();
  var due = readItems_().rows.map(function (r) { return rowToItem_(r.values, today); })
    .filter(function (i) { return nudgeDue(i, today); });
  var result = { due: due.length, dms: 0, channel: 0, failed: 0 };
  if (!due.length) return result;

  var byHandler = {};
  due.forEach(function (i) { (byHandler[i.handler || ''] = byHandler[i.handler || ''] || []).push(i); });
  var ids = readLists_().slackIds || {};
  var line = function (i) {
    return '• ' + itemLink_(i) + '  ' + esc_(i.name) + '\n     *' + esc_(i.status) + '* for ' + i.daysInStatus + ' working days';
  };
  var lines = function (list) {
    return list.slice(0, 20).map(line).join('\n') + (list.length > 20 ? '\n…and ' + (list.length - 20) + ' more' : '');
  };
  var nudged = [], leftover = [];

  Object.keys(byHandler).forEach(function (h) {
    var list = byHandler[h].sort(function (a, b) { return b.daysInStatus - a.daysInStatus; });
    var head = list.length === 1 ? '1 AXO of yours has' : list.length + ' AXOs of yours have';
    var dm = h && ids[h] ? slackDm_(ids[h], {
      text: head + ' been in the same status for ' + NUDGE_AFTER_DAYS + '+ working days',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: *' + head + ' been in the same status for ' + NUDGE_AFTER_DAYS + '+ working days*\n' + lines(list) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Update the status, or add a note in the tracker saying what it is waiting on.' }] }
      ]
    }) : { ok: false };
    if (dm.ok) { result.dms++; nudged = nudged.concat(list); }
    else leftover.push({ handler: h, list: list });
  });

  if (leftover.length) {
    var text = ':hourglass_flowing_sand: *In the same status for ' + NUDGE_AFTER_DAYS + '+ working days*\n' + leftover.map(function (g) {
      return '*' + (g.handler ? who_(g.handler) : 'No handler') + '*\n' + lines(g.list);
    }).join('\n');
    var posted = slackPost_({ text: 'AXOs in the same status for ' + NUDGE_AFTER_DAYS + '+ working days', blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted here because these handlers could not be sent a DM.' }] }] });
    leftover.forEach(function (g) {
      if (posted) { result.channel += g.list.length; nudged = nudged.concat(g.list); } else result.failed += g.list.length;
    });
  }

  if (nudged.length) {
    withLock_(function () {
      var col = colIndex_(), rowOf = {}, data = readItems_();
      data.rows.forEach(function (r) { rowOf[String(r.values[0])] = r.rowNum; });
      var stamp = parseDay_(today);
      nudged.forEach(function (i) {
        if (rowOf[i.id]) data.sheet.getRange(rowOf[i.id], col.lastNudged + 1).setValue(stamp);
      });
    });
  }
  return result;
}

/**
 * Schedules, in the script time zone (Asia/Manila): the weekly digest on Tuesdays at
 * 5 AM, and the 2-day nudges on every working day (Tue-Sat) at NUDGE_HOUR (default 5).
 * Apps Script fires hourly triggers at some point inside the hour. Re-running replaces
 * the earlier schedules.
 */
function installTriggers() {
  var mine = ['sendWeeklyDigest', 'sendDailyDigest', 'sendNudges'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(5).create();
  var hour = Number(PropertiesService.getScriptProperties().getProperty('NUDGE_HOUR'));
  if (!(hour >= 0 && hour <= 23) || isNaN(hour)) hour = 5;
  var names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  WORK_DAYS.forEach(function (d) {
    ScriptApp.newTrigger('sendNudges').timeBased().onWeekDay(ScriptApp.WeekDay[names[d]]).atHour(hour).create();
  });
  return 'Scheduled: weekly digest on Tuesdays at 5 AM, nudges Tuesday to Saturday at ' + hour + ':00 (' + TZ + ')';
}

/** Says who Slack will send DMs as, so a wrong token is caught before anyone gets a message. */
function checkSlackSetup() {
  var p = PropertiesService.getScriptProperties();
  var out = [];
  out.push(p.getProperty('SLACK_WEBHOOK_URL') ? 'Channel posts: webhook is set.' : 'Channel posts: OFF (SLACK_WEBHOOK_URL is not set).');
  var token = p.getProperty('SLACK_BOT_TOKEN');
  if (!token) out.push('DMs: OFF (SLACK_BOT_TOKEN is not set). Review points and nudges go to the channel instead.');
  else if (!/^xoxb-/.test(token)) {
    out.push('DMs: BLOCKED. SLACK_BOT_TOKEN holds a ' + (/^xoxp-/.test(token) ? 'user token (xoxp-), which sends DMs as you' : 'value that is not a bot token') +
      '. Replace it with the "Bot User OAuth Token" (starts with xoxb-) from the Slack app\'s OAuth & Permissions page.');
  } else {
    var res = UrlFetchApp.fetch('https://slack.com/api/auth.test', { method: 'post', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } });
    var body = {};
    try { body = JSON.parse(res.getContentText()); } catch (e) {}
    out.push(body.ok ? 'DMs: OK. Messages are sent as the bot "' + body.user + '" in ' + body.team + '.'
      : 'DMs: Slack rejected the bot token (' + (body.error || 'unknown error') + ').');
  }
  var ids = readLists_().slackIds || {};
  var handlers = readLists_()['Handler'] || [];
  var missing = handlers.filter(function (h) { return !ids[h]; });
  out.push(missing.length ? 'Handlers with no Slack ID in the Lists tab: ' + missing.join(', ') + '.' : 'Every handler has a Slack ID.');
  return out.join('\n');
}

function checkSlackSetupMenu() {
  SpreadsheetApp.getUi().alert(checkSlackSetup());
}

function testSlack() {
  var ok = slackPost_({ text: 'CCQA AXO Tracker is connected to this channel.' });
  if (!ok) throw new Error('Slack did not accept the message. Check SLACK_WEBHOOK_URL in Script properties.');
  return 'Sent';
}
