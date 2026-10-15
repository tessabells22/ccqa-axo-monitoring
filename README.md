# CCQA AXO Monitoring Tracker

Web app for the Carrier Compliance QA team to track AXO items, built the same way as the NPD QA Endorsement Tracker: a Google Apps Script web app that saves to a Google Sheet.

- **Import** the AXO items CSV export. New AXOs are added, existing ones get their AXO fields refreshed. QA fields (status, handler, system, comments, notes) are never overwritten.
- **Item Type** is mapped on import: `defects` → **Bug**, `features` → **User Story**.
- **Track** each item with the columns from the AXO Monitoring 2026 workbook: High Priority, AXO Category, System, Handler, Status, Date of Completion, Comment/Note (DEV), Comment/Note (SED). Status colours match the workbook, except Done, which is slate so it can't be confused with Ongoing BA/DEV.
- **Quarters**: every AXO is tagged with a quarter (Q1–Q4 plus year). Tabs at the top scope the counts, chart and table to one quarter.
- **Dev and BA** are shown under every item name. BA is the AXO export's "Reported By" column.
- **Review points**: setting an item to Review Points opens a box for the reviewing QA to write the points. They're saved on the item and sent to the handler as a Slack DM.
- **Notes**: every item has a timestamped, signed notes thread (General, DEV, SED, Blocker) plus a change history.
- **Slack**: optional channel pings for key status changes, blocker notes, imports and a weekday digest.

## Columns

| From the AXO CSV (refreshed on import) | QA tracking (owned by the team) |
| --- | --- |
| ID, Item Type, Name, Workflow Step, Priority, Developer, BA (from Reported By), Release Notes Description | Quarter, High Priority, AXO Category, System, Handler, Status, Date of Completion, Comment/Note (DEV), Comment/Note (SED) |

The CSV has two `Developer` columns (the first is filled for defects, the second for features); they are merged into one. AXO Category is set from the name prefix on first import (`ERPIS…` → ERPIS, `SERPC…`/`SERPCAR…` → SERPCAR) and can be changed. High Priority starts ticked when the AXO priority is High.

**Quarter** is set when an AXO first arrives: the import dialog asks which quarter to tag new AXOs with (defaults to the quarter you're viewing, or the current one). Re-imports never change it. To carry an unfinished AXO into the next quarter, change its Quarter in the item panel.

**Review points**: choosing Review Points (in the table or the item panel) opens a form instead of saving straight away. The reviewer picks their name and writes the points; sending sets the status, saves the points as a "Review Points" note, and DMs the handler. Cancel leaves the status as it was. While an item is in Review Points, the panel has an *Add review points* button for follow-up rounds.

Status groups follow the workbook's Data Monitoring tab: **In Progress** = Ongoing QA, Ongoing BA/DEV, Awaiting BA/DEV, For Review, Review Points; **Completed** = Done, For Upload; **Discarded** = Moved, Withdraw; blank = **Not Started**. Setting a Completed status stamps today's date if no completion date is set.

## Set up (about 10 minutes)

1. Create a Google Sheet named `CCQA AXO Tracker` in the team's shared drive.
2. In the sheet: **Extensions → Apps Script**. Delete the default `Code.gs`.
3. Create these files and paste in the contents from `src/`:
   `Code.gs`, `Mapping.gs`, `Slack.gs` (Script files) and `Index`, `Styles`, `Script` (HTML files, no extension).
4. **Project Settings** → tick *Show "appsscript.json"*, then replace its contents with `src/appsscript.json`.
5. Select `setup` in the function dropdown and **Run**. Approve the permissions. This creates the Items, Notes, Activity and Lists tabs with dropdowns and status colours.
6. **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone within [your organisation]**. Copy the `/exec` URL and share it with the team.
7. Open the app, click **Import AXO CSV** and load the export.

To change dropdown values (handlers, systems, categories, note kinds), edit the **Lists** tab. No code change needed.

Alternatively, push with [clasp](https://github.com/google/clasp): copy `.clasp.json.example` to `.clasp.json`, put in the script ID, then `npx @google/clasp push`.

### Updating

After changing code: **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. This keeps the same URL. Creating a *new* deployment gives a new URL, which breaks everyone's bookmark.

## Deployment: Apps Script or a cloud platform?

**Use Apps Script.** For this team it's the better fit:

- The team already signs in with Google and the NPD tracker works this way, so there's nothing new to learn or approve.
- Saving is the Google Sheet: version history, sharing and backups come free, and anyone can open the sheet to filter or export.
- No hosting bill, servers, database, or login system to maintain.
- Apps Script handles this size comfortably: a few hundred items a quarter and a dozen people editing.

Move to a cloud platform (Cloud Run / Firebase / Vercel with a real database) only if one of these becomes true:

- People outside the Google organisation need access.
- The tracker grows past a few thousand rows or many people save at the same second. Apps Script quotas and the 1–3 s round trip per save start to show.
- You want AXO to push updates automatically (needs an always-on API and AXO API credentials).

Safeguards already built in: every write takes a script lock, edits only touch the fields that changed (two people editing different fields don't overwrite each other), every change is logged to the Activity tab, and the open page refreshes every minute so you see teammates' changes.

Back it up anyway: in the Sheet, **File → Version history** is automatic. For an extra copy, a weekly **File → Make a copy** into an archive folder is enough. Start a new Sheet each quarter (Q4_2026, Q1_2027…) if you want to mirror the workbook's per-quarter tabs.

## Slack notifications

### Recommended setup

1. Create a channel, for example `#ccqa-axo`.
2. At <https://api.slack.com/apps> → **Create New App → From scratch** → **Incoming Webhooks** → turn on → **Add New Webhook to Workspace** → pick the channel. Copy the webhook URL. (If you can't create apps, ask a Slack admin to do this step.)
3. In Apps Script: **Project Settings → Script properties → Add**:
   - `SLACK_WEBHOOK_URL` = the webhook URL
   - `APP_URL` = the web app `/exec` URL (so messages link straight to the item)
4. Run `testSlack`, then `installTriggers` for the digest.
5. Set up review point DMs (next section).

### Review point DMs

Review points go to the handler as a direct message from the Slack app. A webhook can only post to its one channel, so DMs need a **bot token** plus each handler's **Slack member ID**. Use the same Slack app you made for the webhook.

**1. Give the app permission to send messages**

1. Open <https://api.slack.com/apps> and pick the tracker's app.
2. **OAuth & Permissions → Scopes → Bot Token Scopes → Add an OAuth Scope** → add `chat:write`.
3. Scroll up and click **Install to Workspace** (or **Reinstall to Workspace** if it's already installed) and approve. A scope only takes effect after a (re)install. If your workspace requires admin approval for apps, this step goes to a Slack admin.
4. Copy the **Bot User OAuth Token** shown on that page. It starts with `xoxb-`.

**2. Let people see the app's messages**

**App Home → Show Tabs** → turn on **Messages Tab**. The DMs land in the app's conversation in each person's Slack sidebar under *Apps*.

**3. Save the token in Apps Script**

**Project Settings → Script properties → Add script property**: `SLACK_BOT_TOKEN` = the `xoxb-` token. Keep it only here: don't paste it in the sheet, the code, or a chat. Anyone with edit access to the Apps Script project can read script properties, so keep that list to the people who maintain the tracker.

**4. Map handlers to their Slack accounts**

For each QA, open their Slack profile → **⋮ (More)** → **Copy member ID** (looks like `U04ABCDE12`). In the sheet's **Lists** tab, paste it in the **Handler Slack ID** column on the **same row** as their name in the **Handler** column:

| Handler | … | Handler Slack ID |
| --- | --- | --- |
| Ley - QA | | U04ABCDE12 |
| Tessa - QA | | U05FGHIJ34 |

New team member: add their name to **Handler** and their ID beside it. Reload the tracker so it picks up the change. The same IDs make channel posts @mention the handler.

**5. Test it on yourself**

1. In the tracker, pick your own name in the top bar and assign any AXO to yourself as handler.
2. Set its status to **Review Points**. The box should say *Sent to [your name] as a Slack DM*. If it says the handler can't be DMed, it names what's missing (token or Slack ID).
3. Write a test point and send. You should get a DM from the app within a few seconds.
4. Put the AXO back to its real status and delete the test note row from the **Notes** tab.

**If the DM doesn't arrive**

The tracker falls back to posting the points in the channel with an @mention, and the toast says so. The reason is in Apps Script → **Executions** → the latest `setReviewPoints` run → a log line starting `Slack DM failed:`.

| Error in the log | Fix |
| --- | --- |
| `invalid_auth` or `not_authed` | The token is wrong or was revoked. Copy it again from **OAuth & Permissions** into `SLACK_BOT_TOKEN`. |
| `missing_scope` | `chat:write` is missing, or the app wasn't reinstalled after adding it. Redo step 1. |
| `channel_not_found` or `user_not_found` | The member ID in **Lists** is wrong, or it's on a different row from the handler's name. |
| No log line, toast says "no Slack ID for handler" | The handler's row in **Lists** has no ID, or the name in **Handler** doesn't match the name on the item exactly. |
| `account_inactive` | The person was deactivated in Slack. Remove or update their row. |

### What gets posted

| Event | Why |
| --- | --- |
| Status changes to **Awaiting BA/DEV**, **For Review** or **Done** | These are the hand-offs someone else needs to act on. Change the list with the `SLACK_NOTIFY_STATUSES` property (comma-separated). |
| **Review points** sent | DM to the handler with the points and the reviewer's name. If the handler has no Slack ID or there's no bot token, it posts to the channel with an @mention instead, and the app says so. |
| An item is flagged High Priority, or a handler is assigned | Assignee gets @mentioned. |
| A **Blocker** note is added | Blockers shouldn't wait for someone to open the tracker. Other note types stay in the tracker. |
| An import adds new items | Lists any new high-priority AXOs. |
| Weekday digest at 9 AM (Manila) | Counts by status, high-priority items with no handler, and items stuck in Awaiting BA/DEV for 2+ days. |

Ongoing QA and minor edits are deliberately quiet: a channel that pings on every dropdown change gets muted within a week.

### Later, if you want more

- **Two-way Slack** (mark Done from a Slack button, `/axo 13715` lookups): needs a Slack app with interactivity pointing at the web app. Apps Script can receive it via `doPost`, but Slack's 3-second response limit makes this flaky on Apps Script; this is the point where a small Cloud Run service earns its keep.
- **More DMs** (for example, DM the handler on assignment instead of a channel mention): the bot token is already there, so it's a small change in `Slack.gs`.

## Development

```
npm test                                     # runs the .gs code against an in-memory sheet
node tools/preview-server.js path/to.csv     # local preview at http://localhost:8787
```

The preview runs the real server code on an in-memory sheet; nothing is saved. Don't commit real AXO exports: this repository is public.
