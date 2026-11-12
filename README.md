# CCQA AXO Monitoring Tracker

Web app for the Carrier Compliance QA team to track AXO items, built the same way as the NPD QA Endorsement Tracker: a Google Apps Script web app that saves to a Google Sheet.

- **Import** the AXO items CSV export. New AXOs are added, existing ones get their AXO fields refreshed. QA fields (status, handler, system, notes) are never overwritten.
- **Item Type** is mapped on import: `defects` → **Bug**, `features` → **User Story**.
- **Track** each item with the columns from the AXO Monitoring 2026 workbook: High Priority, AXO Category, System, Handler, Status, Date of Completion. Status colours match the workbook, except Done, which is slate so it can't be confused with Ongoing BA/DEV.
- **Quarters**: every AXO is tagged with a quarter (Q1–Q4 plus year). Tabs at the top scope the counts, chart and table to one quarter.
- **Dev and BA** are shown under every item name. BA is the AXO export's "Reported By" column.
- **Review points**: setting an item to Review Points opens a box for the reviewing QA to write the points. They're saved on the item and sent to the handler as a Slack DM.
- **Notes**: every item has a timestamped, signed notes thread (General or Blocker) plus a change history. The old Comment/Note (DEV) and (SED) boxes were replaced by notes.
- **Days in Status**: each AXO shows how many working days (Tuesday to Saturday) it has been in its current status. After 2 working days the handler gets a Slack DM from the bot.
- **QA workload**: AXOs per handler for the selected quarter, split into in progress, not started, completed and discarded, plus reviews given.
- **Reports**: a quarter or date-range report (summary, status breakdown, workload, activity, items needing attention) that downloads as a PDF.
- **Delete**: remove one, several or all AXOs with a passcode. They move to a Deleted tab and can be restored.
- **Email**: opens a pre-filled Outlook draft with an AXO's details, sent from the person's own work email.
- **Slack**: optional channel pings for key status changes, blocker notes, imports and a weekly digest (Tuesdays, 5 AM Manila).

## Columns

| From the AXO CSV (refreshed on import) | QA tracking (owned by the team) |
| --- | --- |
| ID, Item Type, Name, Workflow Step, Priority, Developer, BA (from Reported By), Release Notes Description | Quarter, High Priority, AXO Category, System, Handler, Status, Date of Completion |

The CSV has two `Developer` columns (the first is filled for defects, the second for features); they are merged into one. AXO Category is set from the name prefix on first import (`ERPIS…` → ERPIS, `SERPC…`/`SERPCAR…` → SERPCAR) and can be changed. High Priority starts ticked when the AXO priority is High.

**Quarter** is set when an AXO first arrives: the import dialog asks which quarter to tag new AXOs with (defaults to the quarter you're viewing, or the current one). Re-imports never change it. To carry an unfinished AXO into the next quarter, change its Quarter in the item panel.

**Review points**: choosing Review Points (in the table or the item panel) opens a form instead of saving straight away. The reviewer picks their name and writes the points; sending sets the status, saves the points as a "Review Points" note, and DMs the handler. Cancel leaves the status as it was. While an item is in Review Points, the panel has an *Add review points* button for follow-up rounds.

Status groups follow the workbook's Data Monitoring tab: **In Progress** = Ongoing QA, Ongoing BA/DEV, Awaiting BA/DEV, For Review, Review Points; **Completed** = Done, For Upload; **Discarded** = Moved, Withdraw; blank = **Not Started**. Setting a Completed status stamps today's date if no completion date is set.

## Set up (about 10 minutes)

1. Create a Google Sheet named `CCQA AXO Tracker` in the team's shared drive.
2. In the sheet: **Extensions → Apps Script**. Delete the default `Code.gs`.
3. Create these files and paste in the contents from `src/`:
   `Code.gs`, `Mapping.gs`, `Slack.gs`, `Report.gs` (Script files) and `Index`, `Styles`, `Script` (HTML files, no extension).
4. **Project Settings** → tick *Show "appsscript.json"*, then replace its contents with `src/appsscript.json`.
5. Select `setup` in the function dropdown and **Run**. Approve the permissions. This creates the Items, Notes, Activity, Lists and Deleted tabs with dropdowns and status colours.
6. **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone within [your organisation]**. Copy the `/exec` URL and share it with the team.
7. Open the app, click **Import AXO CSV** and load the export.

To change dropdown values (handlers, systems, categories, note kinds), Slack member IDs or the default email recipients, edit the **Lists** tab. No code change needed.

Alternatively, push with [clasp](https://github.com/google/clasp): copy `.clasp.json.example` to `.clasp.json`, put in the script ID, then `npx @google/clasp push`.

### Script properties

Set these under **Project Settings → Script properties**. All are optional except where noted.

| Property | What it does |
| --- | --- |
| `DELETE_PASSCODE` | The passcode the tracker asks for before deleting AXOs. Deleting stays switched off until this is set. |
| `SLACK_WEBHOOK_URL` | Turns on channel posts. |
| `SLACK_BOT_TOKEN` | The Slack app's **Bot User OAuth Token** (starts with `xoxb-`). Needed for DMs: review points and nudges. A user token (`xoxp-`) is refused, because Slack would send the DMs as you. |
| `APP_URL` | The web app `/exec` URL, used for links in Slack messages and emails. |
| `SLACK_NOTIFY_STATUSES` | Comma-separated statuses that post to the channel. Default: Awaiting BA/DEV, For Review, Done. |
| `NUDGE_HOUR` | Hour of the day (0–23, Manila time) the nudges go out. Default 5. Run `installTriggers` again after changing it. |

### Updating

After changing code: **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. This keeps the same URL. Creating a *new* deployment gives a new URL, which breaks everyone's bookmark.

### Comment/Note (DEV) and (SED) columns

These two columns are retired: the team writes notes instead. They stay in the Items tab (greyed out) so the column layout doesn't shift. On the first load after the update, any text already in them is copied into that AXO's notes as a DEV or SED note, once. The cells are left as they were, as a record.

### Upgrading from an earlier version

1. Paste the new contents of `Code.gs`, `Mapping.gs`, `Slack.gs`, `Index`, `Styles` and `Script`, and add the new script file `Report.gs`. `appsscript.json` has not changed.
2. Deploy a new version of the existing deployment (see *Updating*).
3. Open the tracker once. It upgrades the sheet by itself: adds the Status Since and Last Nudged columns at the end of Items, the Deleted tab, and the Email To / Email CC columns in Lists. Existing data is not moved or changed, apart from two repairs: earlier versions unticked High Priority and In Latest Import on newly imported rows, and the upgrade ticks them back.
4. Set `DELETE_PASSCODE`, fill in **Email To** / **Email CC** in the Lists tab, and run `installTriggers` once so the nudges are scheduled.

## Day to day

### Days in Status and nudges

Days in Status counts working days, Tuesday to Saturday, since the AXO's Status last changed; the day of the change is not counted, and other edits (handler, notes) don't restart it. Done, Moved and Withdraw show a dash. The working days are the `WORK_DAYS` list at the top of `Mapping.gs`.

On each working day at 5 AM Manila time (`NUDGE_HOUR`), `sendNudges` looks for AXOs that have been in Ongoing QA, Ongoing BA/DEV, Awaiting BA/DEV, For Review, Review Points or For Upload for 2 or more working days. Each handler gets one DM from the bot listing all of their stuck AXOs. An AXO is nudged again only after another 2 working days in the same status. Handlers without a Slack ID, and AXOs with no handler, are listed in one post in the team channel instead. Change the statuses in `NUDGE_STATUSES` and the threshold in `NUDGE_AFTER_DAYS` (`Mapping.gs`).

### Deleting and restoring AXOs

Tick the boxes on the left of the table (the box in the header selects everything in the current view, so with the All tab and no filters that is every AXO), then **Delete**. The tracker asks for the delete passcode, and for 10 or more AXOs you also type DELETE. Five wrong passcodes lock deleting for ten minutes.

Deleted AXOs move to the **Deleted** tab with who deleted them and when. Their notes stay in the Notes tab. To restore: open the Deleted tab in the sheet, select the rows, then **CCQA Tracker → Restore selected rows**. They come back with their status, handler, comments and notes.

A later import skips AXOs that are in the Deleted tab, so a deleted AXO doesn't reappear by itself. The import result says how many were skipped and offers **Import them again**, which adds them as new, not-started AXOs.

### Reports

**Report** in the top bar builds a report for one quarter (or all quarters) and a date range. *AXOs in* decides which AXOs the snapshot sections cover; the dates decide what counts as activity (completed, status changes, review points, blockers). **Download PDF** makes the PDF on the server; **Print** is a fallback that uses the browser's print dialog.

Sections: summary, status breakdown by Bug and User Story, by AXO category, QA workload (including completed, review points received and reviews given in the period), activity in the period, completed in the period, needs attention (2+ working days in one status, high priority still open, blockers raised), and an optional full AXO list.

### Reviewer

The handler doesn't choose the reviewer: another QA takes the review. AXOs in **For Review** with nobody on them show a **Review it** button under their status (not shown to the AXO's own handler). Clicking it makes you the reviewer and the handler gets a Slack DM saying who's reviewing. The **Waiting for a reviewer** tile and the **Reviewer** filter (Me / No reviewer yet / a name) find them. The Reviewer field in the item panel can be changed or cleared, and nobody can be the reviewer of their own AXO.

Sending review points on an AXO with no reviewer makes the sender its reviewer. While an AXO waits in For Review, the 2-day nudge goes to its reviewer instead of the handler; For Review AXOs with no reviewer are listed in the team channel.

### Set status on several AXOs

Tick AXOs, then **Set status** in the selection bar. Everything a single status change does still happens (completion date, days in status), and Slack gets one summary post for the batch instead of one per AXO. Review Points isn't offered: points are written for one AXO at a time.

### Rework

Under each AXO's status, and in its panel, the tracker shows its rework: the number of **review rounds** (Review Points sent) and how many times it went **back to dev**: its status moved from a QA stage (Ongoing QA, For Review, Review Points, For Upload, Done) to Ongoing BA/DEV, or an import moved its AXO workflow step to a Rework step. The counts come from the Notes and Activity tabs, so history recorded before this update counts too. The report adds a *Back to BA/DEV* column to the QA workload and a *Most reworked AXOs* list.

### Release

Each AXO has a **Release** field (in its panel), holding the number only, for example `5.4`. The tracker shows it with the category in front (`ERPIS 5.4`, `SERPCAR 3.8`), taken from the AXO Category, and the email uses it. To set it on many AXOs at once, tick them and click **Set release** in the selection bar. If someone types `ERPIS 5.4`, the prefix is dropped and `5.4` is stored.

### Email

**Email** in an AXO's panel drafts the test file submission email, worded like the team's Test File Submission Drafter: greeting, the AXO type and **release**, the AXO in bold, the system it was tested in, and the standard closing. To send several test files in one email, tick the AXOs and click **Email test files** in the selection bar.

- **Release** comes from the AXOs' Release field. If none is set, a name like "for 3.8 Release" is used, or it can be typed in the email box.
- **System** comes from the AXO's System; if it's empty, SERPCAR defaults to WD1 and ERPIS to DEV.
- Default **To** and **CC** come from the **Email To** and **Email CC** columns in the Lists tab, one address per row.

**Open in Outlook on the web** opens a new email with To, CC and subject filled in, and copies the message. Clicking in the message area and pressing Ctrl+V (⌘V on a Mac) pastes it with its bold text. The copied message sets no font, so it takes the person's Outlook default font. A link can only carry plain text, which is why the message is pasted rather than sent in the link. CC travels in the `mailtouri` part of the link, the form Outlook on the web uses for email links.

**Fill in the message automatically** (a checkbox in the email box, remembered per browser) puts the message in the link instead, so it's already there when Outlook opens. A link can only carry plain text, so nothing is bold that way.

**Copy message** copies the formatted text on its own. **Download .eml** is for the Outlook desktop app: opening the file there gives a new draft with To, CC and bold text.

Nothing is sent by the tracker: the person attaches the test file and clicks Send, from their own work email. Sending with no draft step would need your Microsoft 365 admin to approve an app with permission to send mail (Microsoft Graph `Mail.Send`) or a Power Automate flow with a premium HTTP trigger.

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
4. Run `testSlack`, then `installTriggers` to schedule the weekly digest and the 2-day nudges (Tuesday to Saturday). Apps Script fires it some time between 5:00 and 6:00 AM on Tuesday; run `sendWeeklyDigest` to see one now.
5. Set up review point DMs (next section).

### Review point DMs

Review points go to the handler as a direct message from the Slack app. A webhook can only post to its one channel, so DMs need a **bot token** plus each handler's **Slack member ID**. Use the same Slack app you made for the webhook.

**1. Give the app permission to send messages**

1. Open <https://api.slack.com/apps> and pick the tracker's app.
2. **OAuth & Permissions → Scopes → Bot Token Scopes → Add an OAuth Scope** → add `chat:write`.
3. Scroll up and click **Install to Workspace** (or **Reinstall to Workspace** if it's already installed) and approve. A scope only takes effect after a (re)install. If your workspace requires admin approval for apps, this step goes to a Slack admin.
4. Copy the **Bot User OAuth Token** shown on that page. It starts with `xoxb-`. Do not use the *User OAuth Token* (`xoxp-`) shown above it: with that one Slack sends the DMs from your own account. The tracker refuses a user token and says so on the main page.

To check which account Slack will send as: in the sheet, **CCQA Tracker → Check Slack setup**.

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
| An AXO stays in the same status for 2+ working days | DM to the handler from the bot, one message listing all of their stuck AXOs. See *Days in Status and nudges*. |
| An item is flagged High Priority, or a handler is assigned | Assignee gets @mentioned. |
| A **Blocker** note is added | Blockers shouldn't wait for someone to open the tracker. Other note types stay in the tracker. |
| An import adds new items | Lists any new high-priority AXOs. |
| Weekly digest, Tuesdays at 5 AM (Manila) | Counts by status, high-priority items with no handler, and items in Awaiting BA/DEV for 2+ working days. |

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
