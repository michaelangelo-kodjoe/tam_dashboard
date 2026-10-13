TAM Command Center — Full Rebuild Prompt / Product & Engineering Specification  
Purpose of this document  
Use this entire document as the master prompt for another coding agent, application builder, or engineering team to recreate the TAM Command Center from scratch.  
The goal is to rebuild the intended current product, not to reproduce historical bugs or obsolete UI patterns.  
Reference state  
The latest known development behavior is based on DEV v8.5.4 / SQLite schema 7 as of 2026-10-12. Production was intentionally kept on a separate baseline while DEV validation continued.  
A new implementation does not need to preserve those exact version numbers, but it must preserve the product behavior, safety model, data semantics, and UX described below.  
  
1. Master Build Instruction  
Build a personal Technical Account Manager (TAM) Command Center for a Bloomberg-style enterprise support workflow.  
This is not a sales CRM. It is a personal operational workspace for one TAM to manage:  
- daily actions,  
- client/account follow-ups,  
- tasks and waiting items,  
- meeting/call/general notes,  
- account history,  
- client contacts,  
- infrastructure,  
- quarterly server/appliance software upgrades,  
- BAMS infrastructure monitoring and alerting,  
- Bloomberg support references,  
- backups, migrations, audit history, and diagnostics.  
The product should feel like a professional Bloomberg-inspired operational application, not a generic SaaS admin dashboard.  
The primary product question is:  
What needs my attention today, for which account, and what do I need to do next?  
  
Secondary questions:  
1. What is happening on this account?  
2. What is overdue or waiting?  
3. What infrastructure event is coming next?  
4. Which server upgrades are approaching?  
5. Are any monitored appliances unhealthy?  
6. What did I discuss with the client recently?  
7. What changed in the account?  
8. What information do I need before the next client touch?  
2. Product Context  
Primary user  
The application is for one Technical Account Manager.  
Do not optimize the first release for:  
- teams of TAMs,  
- territory assignment,  
- sales pipelines,  
- opportunity management,  
- revenue forecasting,  
- generic CRM lead management,  
- marketing workflows.  
Future multi-user support may be possible later, but it is not a core requirement for this build.  
Core operating model  
The TAM works across multiple enterprise accounts and needs one workspace that combines:  
- account context,  
- operational action items,  
- technical infrastructure,  
- upgrades,  
- BAMS monitoring,  
- account history,  
- meeting/call notes.  
The application should minimize the need to check multiple spreadsheets or separate local tools.  
3. Technical Architecture  
Preferred architecture  
Build this as a local Windows workstation application:  
Browser UI  
   |  
   v  
Local HTTP API on 127.0.0.1  
   |  
   +--> SQLite  
   +--> Bloomberg Desktop API / BLPAPI  
   +--> Windows notifications  
   +--> Excel import/export  
   +--> Internal TEAM/CMS schedule retrieval  
Backend  
Preferred:  
- Python 3.10+  
- local HTTP server bound to 127.0.0.1  
- SQLite  
- openpyxl for .xlsx  
- Bloomberg blpapi when available  
- Windows PowerShell integration only where appropriate  
A lightweight framework such as FastAPI/Flask is acceptable in a clean rebuild, but it is not required. If introducing a framework, preserve the local-only deployment and simple Windows startup.  
Frontend  
You may choose either:  
Option A — zero-build frontend  
- semantic HTML  
- modern CSS  
- vanilla JavaScript  
Option B — React + TypeScript  
- preferred only if the application is being rebuilt cleanly with a reliable packaged build  
- do not require the end user to run Node/npm to start the application  
- compile frontend assets as part of release packaging  
Do not introduce Tailwind or a large UI kit merely for convenience. Use a custom Bloomberg-inspired design system.  
Persistence  
Use SQLite as the local source of truth.  
Suggested locations:  
DEV:  
<application folder>\dev_data\tam_dev.db  
Production:  
%LOCALAPPDATA%\TAM_Command_Center\tam_command_center.db  
Backups:  
%LOCALAPPDATA%\TAM_Command_Center\TAM_Backups  
Logs:  
%LOCALAPPDATA%\TAM_Command_Center\logs  
4. Non-Negotiable Environment Safety  
DEV and Production must be isolated.  
Requirements:  
- Never use Production as a test database.  
- DEV must have a clearly separate DB.  
- DEV should support simulated BAMS data.  
- Production must never silently use simulated BAMS data.  
- Production must fail closed if BLPAPI is unavailable.  
- A DEV build must be able to reject Production runtime mode.  
- Do not package a working user database inside the release archive.  
- Do not automatically promote/copy DEV DB into Production.  
- Use one application instance per database.  
- Protect against two local processes monitoring/writing the same SQLite DB.  
- Before schema upgrade on an existing Production DB, create a safety backup.  
- Use SQLite online backup APIs rather than unsafe file replacement when WAL is active.  
5. Mandatory Product Navigation  
Use a persistent left navigation rail with clear semantic icons.  
Primary sections:  
1. Today  
2. Accounts  
3. Tasks  
4. Operations  
5. BAMS  
6. ChatGPT Bridge  
7. Settings  
Do not use a separate Journal item as a primary destination.  
Journal/history behavior belongs primarily under:  
Account Workspace -> Activity  
The navigation should be visually obvious and easy to understand without training.  
6. Visual Design Direction  
Overall aesthetic  
Use a Bloomberg-inspired dark technical interface:  
- near-black primary background  
- dark navy/charcoal surfaces  
- amber/orange as the dominant interactive accent  
- blue for links/informational states  
- green for healthy/passed/live  
- amber for waiting/caution  
- red for overdue/critical/failed  
- gray for neutral states  
Avoid:  
- generic white SaaS dashboards,  
- purple gradients,  
- glassmorphism everywhere,  
- excessive rounded cards,  
- native white browser buttons,  
- raw browser select dropdowns,  
- oversized marketing-style headings.  
Density  
Use a middle-density operational layout:  
- more compact than a typical CRM,  
- less compressed than Bloomberg Terminal,  
- optimized for long working sessions,  
- clear enough for immediate navigation.  
Icons  
Use a consistent line-icon system across:  
- left navigation,  
- account tabs,  
- section headings,  
- buttons,  
- status summaries,  
- infrastructure sections.  
Active navigation icon:  
- amber/orange.  
Inactive:  
- muted gray.  
Buttons  
All buttons must have designed states:  
- default,  
- hover,  
- active,  
- disabled,  
- keyboard focus.  
Never allow browser-native white buttons to appear inside dark tables/cards.  
Dropdowns  
Do not use visually raw browser-native dropdown popups.  
Implement a reusable styled select-only combobox/listbox while retaining an accessible/select-compatible data model.  
Requirements:  
- dark popup surface,  
- selected checkmark,  
- hover/focus state,  
- keyboard navigation,  
- Arrow Up/Down,  
- Home/End,  
- Enter/Space,  
- Escape,  
- Tab close,  
- visible focus,  
- viewport-aware positioning,  
- WAI-ARIA combobox/listbox semantics.  
7. Today — Daily Action Workspace  
Today is the default landing page.  
Its primary job is daily prioritization, not general analytics.  
Main component: Prioritized Work Queue  
Combine the most important actionable items across:  
- overdue tasks,  
- tasks due today,  
- waiting/follow-up tasks,  
- client follow-up dates,  
- active BAMS alerts,  
- near-term server upgrades,  
- post-upgrade validation required.  
Rank roughly by:  
Overdue/Critical  
-> High-priority due today  
-> Active infrastructure alerts  
-> Waiting items needing follow-up  
-> Near-term upgrade actions  
-> Upcoming tasks  
Each item should show:  
- account,  
- item type,  
- title,  
- urgency/status,  
- due/event date,  
- relevant waiting owner or context.  
Clicking an item should navigate to the correct underlying object.  
Secondary Today areas  
Upcoming  
Show upcoming obligations/events such as:  
- server upgrades,  
- next client touch,  
- tasks due later this week.  
Recently Changed  
Show concise account-level changes:  
- note created,  
- task completed,  
- upgrade updated,  
- BAMS alert opened/recovered/closed,  
- contact changed.  
Account Load  
A compact cross-account directory/snapshot may appear below the work queue.  
It must support fast navigation to an Account Workspace.  
Do not let account metrics overwhelm the prioritized queue.  
8. Accounts Directory  
The Accounts page should be optimized for navigation and workload awareness.  
Prefer a dense list/table over large generic cards.  
Recommended columns:  
Account  
Open Tasks  
Overdue  
Waiting  
BAMS Alerts  
Next Upgrade  
Next Contact  
Do not invent an opaque numerical health score.  
Do not make sales/commercial fields part of the core model.  
Clicking an account opens the full Account Workspace.  
9. Full Account Workspace  
Each account must have one dedicated working surface.  
Use this tab model:  
Overview | Tasks | Activity | Infrastructure | Contacts  
Use icons in the tabs.  
The account header should show:  
- account name,  
- BPID if available,  
- product/context metadata if stored,  
- high-level counts such as open tasks, overdue, waiting, servers, active BAMS alerts, upcoming upgrades.  
Do not overdecorate the header.  
10. Account Overview  
The Overview is an action-oriented summary.  
Open Tasks  
This is the most important account-level section.  
Display the top 5–8 open tasks, sorted by:  
Overdue  
-> Priority  
-> Due Date  
Rows should be clickable.  
Avoid unnecessary Open buttons in compact lists. Use row navigation and a restrained hover chevron.  
A View All action may open the account Tasks tab.  
Recent Activity  
Show a compact account timeline with a mix of:  
- meeting notes,  
- call notes,  
- general notes,  
- task lifecycle changes,  
- server upgrade changes,  
- BAMS alerts,  
- contact changes.  
Manual notes and automated system events must be visually distinguishable.  
Account Brief / Context Rail  
Use a continuous right-hand context surface rather than multiple disconnected mini-cards.  
Include:  
Next Client Touch  
- next date,  
- relative timing,  
- relevant account/contact if available.  
Infrastructure Snapshot  
- number of servers/appliances,  
- active BAMS alerts,  
- next upgrade,  
- basic environment summary.  
Contacts  
Show a small list of key contacts:  
- Name  
- Role  
- Team  
- Email  
- Primary marker  
11. Account Tasks  
Show all open tasks for the selected account.  
Task fields:  
- Task  
- Account  
- Category  
- Priority  
- Due Date  
- Next Update  
- Status  
- Waiting On  
- Notes  
- Archived state  
- created/updated timestamps  
Task categories should support at least:  
- Client Follow-Up  
- Engineering Follow-Up  
- Reporting  
- Internal  
- Escalation  
- Onboarding  
- Entitlements  
- Usage Review  
- Meeting  
- Other  
Priority:  
- High  
- Medium  
- Low  
Status:  
- Not Started  
- In Progress  
- Waiting  
- Complete  
Support:  
- create,  
- edit,  
- archive,  
- delete,  
- filtering,  
- search.  
Writes should be audited.  
12. Account Activity  
This is the account history and relationship record.  
Filters:  
All  
Meeting Notes  
Call Notes  
General  
System Events  
Manual notes  
Types:  
- Meeting Note  
- Call Note  
- General Note  
Fields:  
- Account  
- Type  
- Timestamp  
- Subject  
- Body  
- Action Items  
- Source  
- created/updated timestamps  
Manual notes must support:  
- create,  
- edit,  
- delete.  
Delete requires:  
- confirmation,  
- safety-backed DB write,  
- audit event.  
System events  
Examples:  
- Task created  
- Task completed  
- Server upgrade scheduled  
- Server upgrade completed  
- BAMS alert opened  
- BAMS alert recovered  
- BAMS alert closed  
- Contact added/updated  
Do not allow users to directly edit system history entries as if they were manual notes.  
13. Contacts  
Keep contacts deliberately lightweight.  
Fields:  
Account  
Name  
Role  
Email  
Team  
Primary  
Requirements:  
- multiple contacts per account,  
- exactly one or zero Primary contact,  
- setting one contact Primary should clear the previous Primary for that account,  
- create/edit/delete.  
Do not expand into a full relationship-management/contact-sales suite.  
14. Infrastructure  
The application tracks infrastructure, not application inventory.  
Account Infrastructure should combine:  
- monitored server/appliance objects,  
- environment,  
- location,  
- region,  
- BAMS status,  
- software version where available,  
- quarterly server-upgrade records,  
- upcoming upgrade date,  
- last/validation status.  
Do not build a CMDB or application dependency model unless explicitly requested later.  
15. Operations — Quarterly Server Upgrade Workbench  
Operations is the cross-account infrastructure upgrade workspace.  
The page should be designed around the TAM decision flow:  
1. What is the next maintenance weekend?  
2. Which servers are affected?  
3. Which items need my attention?  
4. Which clients are still waiting?  
5. Which upgrades need validation?  
6. What is the full schedule?  
Top controls  
Provide:  
- Release selector  
- Sync  
- Diagnostics  
- Bulk Upload  
- + Server Upgrade  
- source schedule link  
Release selection  
The release selector must populate from synchronized schedule data.  
Do not hard-code the UI to 2026.  
The schedule parser must support any future heading matching:  
20XX Upgrade Schedule  
20XX Software Upgrade Schedule  
Examples:  
- 2026  
- 2027  
- 2028  
- future years without code changes.  
Visible progression  
Do not show Client Notice in the operational progression.  
Show:  
DEV -> PROD EAST -> PROD WEST  
The order of East/West is determined by source dates. Display chronologically even if West occurs before East in a quarter.  
Next Upgrade Weekend  
Automatically compute the earliest future event across all synchronized release windows:  
DEV  
East  
West  
Then:  
- choose the release containing that event,  
- show event type/polarity,  
- date,  
- countdown,  
- number of assigned servers.  
16. Authoritative Quarterly Upgrade Source  
Internal source:  
https://cms.prod.bloomberg.com/team/spaces/SUPP/pages/2066950120/Quarterly+Software+Upgrades  
The page contains quarterly schedules for Bloomberg Enterprise Products.  
The synchronizer should extract per release:  
year  
quarter  
DEV upgrade date  
first Production weekend + polarity  
second Production weekend + polarity  
APICS version  
CD Rules version  
MFA software version  
MFA rules version  
maintenance window  
source URL  
source sync timestamp  
source method  
source fingerprint/hash  
Do not assume:  
- East is always first,  
- West is always second,  
- schedule is only for 2026,  
- the first table after a year heading is always the schedule.  
Recognize the schedule table using semantic header matching.  
17. Quarterly Schedule Retrieval Strategy  
Implement the schedule provider behind an adapter/interface.  
Example:  
class UpgradeScheduleProvider:  
    def fetch(self) -> ScheduleFetchResult:  
        ...  
Support multiple retrieval methods.  
Windows attempt  
Try a Windows/internal-auth-compatible retrieval method first.  
Historically:  
- PowerShell Invoke-WebRequest  
- default Windows credentials  
may be attempted.  
Fallback  
A standard HTTPS request may be attempted as a fallback.  
Important  
The app must not assume a successful HTTP response means the schedule was retrieved.  
Classify content.  
18. Schedule Sync Diagnostics  
The sync must classify failures into meaningful categories.  
Required classifications:  
success  
auth_required  
access_denied  
cms_shell  
parser_mismatch  
network_error  
unexpected_content  
success  
The expected page/schedule markers are found and at least one valid quarterly schedule is parsed.  
auth_required  
Detect:  
- redirect/final host pointing to BSSO/SSO,  
- BSSO/SAML login page markers,  
- Bloomberg Single Sign-On content.  
access_denied  
Detect:  
- HTTP 401,  
- HTTP 403,  
- explicit permissions/access denied response.  
cms_shell  
The request reaches cms.prod.bloomberg.com but raw content does not contain the upgrade schedule/table.  
This may mean:  
- authenticated browser rendering is required,  
- JS-app content is loaded separately,  
- an internal content/API path is required.  
parser_mismatch  
The correct Quarterly Software Upgrades page and expected schedule/table headers exist, but no valid rows can be parsed.  
network_error  
Examples:  
- DNS  
- timeout  
- TLS  
- proxy  
- connection failure  
unexpected_content  
Anything not matching the above.  
19. Diagnostics UI  
Operations should have a dedicated Diagnostics dialog/panel.  
Display safe metadata only:  
- classification,  
- HTTP status,  
- final host,  
- page title,  
- content type,  
- response length,  
- sanitized final URL,  
- whether expected markers were found,  
- discovered schedule years,  
- candidate tables,  
- recognized schedule tables,  
- parsed release windows,  
- retrieval method/attempt summary.  
Never persist:  
- cookies,  
- BSSO tokens,  
- Authorization headers,  
- credentials,  
- full authenticated HTML,  
- URL query strings that may contain authentication state.  
Sanitize URLs before persistence.  
20. Schedule Fallback / Fail-Closed Behavior  
If live retrieval fails:  
- keep last successfully synchronized schedule,  
- if none exists, use a small bundled fallback,  
- do not wipe schedule rows,  
- do not delete server upgrade records,  
- clearly show Cached vs Synchronized.  
The bundled fallback is only an offline safety net.  
The application must not be permanently tied to a bundled year.  
21. Known 2026 Reference Fixture  
Use this only as a parser/test fixture and offline fallback.  
2026 Q4:  
DEV: 2026-10-09  
PROD East: 2026-11-13  
PROD West: 2026-11-20  
APICS: 4.78.0  
CD Rules: 26.4.6.1  
MFA software: 3.8.1-1  
MFA rules: 1.24.0  
Maintenance: Friday 19:00 NY - Sunday 12:00 NY  
Do not treat this as the permanent product schedule.  
22. Server Upgrade Data Model  
Each server upgrade should include:  
id  
account/client_id  
server_name  
environment  
polarity  
schedule_year  
schedule_quarter  
current_version  
target_version  
scheduled_date  
maintenance_window  
status  
validation_status  
waiting_on  
reference  
notes  
source_url  
created_at  
updated_at  
Environment:  
- PROD  
- DEV  
Polarity:  
- East  
- West  
- DEV  
For PROD:  
- East or West is required.  
For DEV:  
- normalize polarity to DEV.  
Scheduled date:  
- derive from release + environment/polarity.  
- user should not type an arbitrary date for standard quarterly upgrades.  
Target version:  
- derive from APICS version in the selected release.  
23. Server Upgrade Statuses  
Support:  
Planned  
Awaiting Client  
Scheduled  
In Progress  
Validation Required  
Completed  
Deferred  
Exception  
Validation:  
Pending  
Passed  
Failed  
Not Required  
24. Operations Working Queue  
Primary views:  
All  
Needs Attention  
Next 30 Days  
Overdue  
Completed  
Filters:  
- Account  
- Polarity  
- Status  
Provide:  
- Reset Filters  
Needs Attention should include  
- overdue and not Completed,  
- Awaiting Client,  
- Validation Required,  
- Failed validation,  
- Completed + Pending validation,  
- Deferred,  
- Exception.  
The server table should be date-first and action-first.  
Recommended columns:  
Upgrade Date  
Account / Server  
Environment / Polarity  
Current -> Target Version  
Status  
Validation  
Waiting On  
Reference  
Actions  
Account names should link into the Account Workspace.  
25. Bulk Server Upgrade Upload  
Operations needs a robust bulk workflow.  
Bulk Upload flow  
1. Click Bulk Upload  
2. Choose Apply to Release  
3. Download template  
4. Populate workbook  
5. Upload/drag/drop .xlsx  
6. Preview  
7. Show counts:  
   - Valid  
   - New  
   - Updates  
   - Invalid  
8. Show row-level validation errors  
9. User explicitly selects Apply Valid Rows  
10. Write atomically  
Nothing writes before Preview.  
Template workbook  
Generate dynamically using openpyxl.  
Sheets:  
- Instructions  
- Server Upgrades  
- hidden Lists  
Columns:  
Account  
Server / Appliance  
Environment  
Polarity  
Current Version  
Status  
Validation Status  
Waiting On  
Reference  
Notes  
Account validation list:  
- generated from current active account names.  
Other dropdown validation:  
- Environment  
- Polarity  
- Status  
- Validation Status  
Import rules  
- Account must already exist.  
- Server/Appliance required.  
- Current Version required.  
- PROD requires East or West.  
- DEV normalizes polarity to DEV.  
- release is selected in the UI, not in each row.  
- scheduled date comes from selected release.  
- target version comes from selected APICS.  
- duplicate identity:  
  Account + Server + Release  
- re-import same identity = Update, not duplicate.  
- preview limit: approximately 500 nonblank rows.  
- before apply, create one DB safety backup.  
- apply all valid rows in one transaction.  
- create audit events with source Bulk Import.  
26. BAMS Monitoring  
BAMS remains a major global page and an account-level infrastructure signal.  
Provider  
Production:  
- Bloomberg Desktop API / BLPAPI  
- local service endpoint localhost:8194  
- read-only snapshot polling  
DEV:  
- simulated provider allowed.  
Production:  
- no simulated fallback.  
Default polling  
Approximately:  
60 seconds  
UI refresh frequency must not increase the underlying Bloomberg request cadence.  
Monitored object  
Fields:  
- Account  
- appliance/server name  
- region  
- location  
- enabled  
Metric  
Fields:  
- object  
- metric name  
- ticker  
- current value  
- last source update  
- last received  
- 30-day high  
- 60-day high  
- 90-day high  
- stale threshold  
- enabled  
Alert rule  
Support:  
- fixed threshold,  
- percentage of historical high,  
- exceeds historical high.  
Operator:  
-  
- =  
- <  
- <=  
Reference:  
- 30-day high  
- 60-day high  
- 90-day high  
Severity:  
- Info  
- Warning  
- Critical  
Other settings:  
- consecutive updates,  
- cooldown,  
- enabled,  
- suppression-until-clear.  
27. BAMS Alert Lifecycle  
Required lifecycle:  
Normal  
-> Threshold breached  
-> Alert opens  
-> Metric may recover  
-> Alert remains visible as recovered / awaiting close  
-> User explicitly closes alert  
Recovery must not automatically close the event.  
Repeated breach observations update the existing open event instead of creating duplicate events.  
If an alert is manually closed while still breaching:  
- suppress reopening until the metric clears.  
Stale handling  
Suggested defaults:  
- Live: <= 75 sec old  
- Delayed: 76–120 sec  
- Stale: > 120 sec  
Provider outages/no-update cycles must freeze lifecycle evaluation rather than create alert/recovery storms.  
28. BAMS Notifications  
Support:  
- in-app notifications,  
- Windows desktop notifications,  
- optional recovery notifications,  
- Privacy Mode.  
Avoid:  
- flashing browser tabs,  
- changing browser title for alerts.  
Persist notification attempts/logging where useful.  
29. BAMS Global UI  
Global BAMS should support:  
Top controls:  
- account filter,  
- import,  
- add appliance,  
- view alerts,  
- alert configuration,  
- monitor start/stop.  
Quick views:  
- All  
- Active Alerts  
- Delayed/Stale  
- Live  
- No Data  
Filters:  
- Location  
- Appliance  
- Metric  
- Status  
- Search  
Table:  
- Appliance  
- Location  
- Metric  
- Current  
- 30D High  
- 60D High  
- 90D High  
- Last Update  
- Status  
Metric details should support history/trend inspection.  
30. ChatGPT Bridge  
Keep a controlled manual integration.  
Do not directly let generated AI text modify the database without preview.  
Workflow:  
1. Select account  
2. Copy Account Context  
3. User sends context to ChatGPT/AI  
4. AI returns a structured update format  
5. User pastes update into Command Center  
6. Command Center parses it  
7. Show Preview  
8. User explicitly Apply  
Use a stable format such as:  
{  
  "format": "TAM_UPDATE_V1",  
  "account": "...",  
  "notes": [],  
  "tasks": []  
}  
No generated change writes without a preview/apply step.  
31. Quick Capture  
Provide one global + Capture control.  
Support:  
- Task  
- Client Follow-Up  
- Meeting Note  
- Call Note  
- General Note  
Prefer selecting account early in the flow.  
The control should be available from core pages without forcing navigation.  
32. Search / Navigation  
Provide:  
- global account jump/search,  
- page-specific search where useful,  
- account filters,  
- table sorting/filtering,  
- keyboard-visible focus.  
Navigation from cross-account data back to account context should be easy.  
Example:  
- click Account name in Operations -> Account Workspace  
- click BAMS account -> Account Infrastructure  
- click Today task -> underlying Task/account  
33. SQLite Schema  
Implement at least the following logical tables.  
app_meta  
key TEXT PRIMARY KEY  
value TEXT NOT NULL  
Use for:  
- schema version,  
- settings metadata,  
- schedule diagnostics cache,  
- migration flags.  
clients  
id TEXT PRIMARY KEY  
name TEXT UNIQUE NOT NULL  
status TEXT DEFAULT 'Active'  
bpid TEXT  
products TEXT  
contact TEXT  
last_contact TEXT  
next_contact TEXT  
notes TEXT  
created_at TEXT  
updated_at TEXT  
contact may remain for backward compatibility, but new contact modeling should use contacts.  
contacts  
id TEXT PRIMARY KEY  
client_id TEXT NOT NULL  
name TEXT NOT NULL  
role TEXT  
email TEXT  
team TEXT  
is_primary INTEGER DEFAULT 0  
created_at TEXT  
updated_at TEXT  
FK -> clients, cascade delete.  
tasks  
id TEXT PRIMARY KEY  
task TEXT NOT NULL  
client_id TEXT NULL  
category TEXT  
priority TEXT  
due TEXT  
next_update TEXT  
status TEXT  
waiting TEXT  
notes TEXT  
archived INTEGER DEFAULT 0  
created_at TEXT  
updated_at TEXT  
notes  
id TEXT PRIMARY KEY  
client_id TEXT NOT NULL  
note_type TEXT  
timestamp TEXT  
subject TEXT  
body TEXT  
action_items TEXT  
source TEXT  
created_at TEXT  
updated_at TEXT  
support_cases  
Optional but supported:  
id  
client_id  
case_type  
reference_id  
summary  
escalated  
created_at  
updated_at  
audit_events  
id  
timestamp  
category  
client_id  
object_type  
object_id  
action  
old_value  
new_value  
reason  
source  
quarterly_upgrade_windows  
schedule_year INTEGER  
schedule_quarter TEXT  
notification_date TEXT  
dev_upgrade_date TEXT  
east_prod_date TEXT  
west_prod_date TEXT  
apics_version TEXT  
cd_rules_version TEXT  
mfa_software_version TEXT  
mfa_rules_version TEXT  
maintenance_window TEXT  
source_url TEXT  
source_sync_at TEXT  
source_sync_method TEXT  
source_fingerprint TEXT  
updated_at TEXT  
PRIMARY KEY(schedule_year, schedule_quarter)  
Notification date may remain in storage for completeness, but do not show Client Notice in the main Operations flow.  
server_upgrades  
id  
client_id  
server_name  
environment  
polarity  
schedule_year  
schedule_quarter  
current_version  
target_version  
scheduled_date  
maintenance_window  
status  
validation_status  
waiting_on  
reference  
notes  
source_url  
created_at  
updated_at  
BAMS tables  
bams_objects  
id  
client_id  
name  
region  
location  
enabled  
created_at  
updated_at  
UNIQUE(client_id, name)  
bams_metrics  
id  
object_id  
metric_name  
ticker UNIQUE  
current_value  
last_source_update  
last_received  
high_30  
high_30_date  
high_60  
high_60_date  
high_90  
high_90_date  
enabled  
stale_after_seconds  
stale_suppressed  
created_at  
updated_at  
bams_alert_rules  
id  
metric_id  
rule_type  
operator  
threshold  
reference_period  
consecutive_updates  
severity  
cooldown_minutes  
enabled  
breach_count  
suppress_until_clear  
created_at  
updated_at  
bams_alert_events  
id  
metric_id  
rule_id  
alert_type  
severity  
message  
opened_at  
last_triggered_at  
recovered_at  
closed_at  
status  
current_value  
trigger_value  
peak_value  
closed_note  
created_at  
updated_at  
bams_metric_samples  
id INTEGER AUTOINCREMENT  
metric_id  
sampled_at  
source_update  
value  
bams_alert_configs  
Reusable/starter configurations:  
id  
name UNIQUE  
metric_match  
rule_type  
operator  
threshold  
reference_period  
consecutive_updates  
severity  
cooldown_minutes  
enabled  
starter  
created_at  
updated_at  
bams_notification_log  
id INTEGER AUTOINCREMENT  
event_id  
kind  
channel  
attempted_at  
success  
detail  
UNIQUE(event_id, kind, channel)  
34. Recommended API Surface  
Build a clean local API.  
At minimum support routes conceptually equivalent to:  
State / settings  
GET  /api/state  
GET  /api/settings  
POST /api/settings/save  
GET  /api/logs/recent  
Accounts  
POST /api/client/save  
POST /api/client/delete  
Contacts  
POST /api/contact/save  
POST /api/contact/delete  
Tasks  
POST /api/task/save  
POST /api/task/archive  
POST /api/task/delete  
Notes  
POST /api/note/save  
POST /api/note/delete  
Operations  
POST /api/operations/schedule/sync  
POST /api/operations/server-upgrade/save  
POST /api/operations/server-upgrade/delete  
GET  /api/operations/server-upgrade/template  
POST /api/operations/server-upgrade/import/preview  
POST /api/operations/server-upgrade/import/apply  
BAMS  
GET/POST equivalents for:  
state  
monitor toggle  
poll  
appliance save/delete  
metric save/delete  
rule save/delete  
bulk rule save  
alert close  
close all alerts  
history  
import inspect/apply  
notification settings/test  
alert configurations  
Import/export/backups  
GET  /api/export/database  
GET  /api/export/excel  
POST /api/import/inspect  
POST /api/import/preview  
POST /api/import/apply  
POST /api/data/backup  
POST /api/data/reset  
POST /api/restore/excel  
ChatGPT Bridge  
GET  /api/context  
POST /api/chat/apply  
DEV-only endpoints must be guarded and unavailable in Production.  
35. Audit Trail  
Maintain a centralized audit history.  
Audit:  
- account create/update/delete,  
- task lifecycle,  
- note create/edit/delete,  
- contact changes,  
- bulk server imports,  
- server upgrade changes,  
- relevant settings changes,  
- BAMS configuration changes where meaningful.  
Store:  
- timestamp,  
- account,  
- object type,  
- object id,  
- action,  
- old/new values where reasonable,  
- reason,  
- source.  
Sources may include:  
- GUI  
- Bulk Import  
- ChatGPT Bridge  
- Migration  
- System  
36. Backup & Recovery  
Every risky write path should have safety behavior.  
Requirements:  
- native SQLite backup,  
- downloadable DB backup,  
- Excel export,  
- Excel restore/import where supported,  
- safety backup before destructive reset,  
- safety backup before bulk import,  
- safety backup before risky DB replacement/migration.  
Do not copy an active WAL database with naive shutil.copy or file replacement.  
Use SQLite backup semantics.  
37. Import / Migration  
Support:  
- task/action tracker import,  
- account/client list import,  
- prior Command Center migration.  
Use:  
- Inspect  
- Preview  
- Apply  
Do not perform blind import.  
Show:  
- rows detected,  
- fields mapped,  
- warnings/errors,  
- expected creates/updates.  
38. Bloomberg References  
Recognize internal references in text such as:  
{DRQS 123456 <GO>}  
{SDSK 123456 <GO>}  
Where appropriate, render Bloomberg-compatible links (bbg://screens/...) rather than leaving everything as plain text.  
Do not assume every arbitrary string is safe to convert.  
39. Settings  
Provide settings for at least:  
- default landing page,  
- open browser on start,  
- start with Windows,  
- local vs GMT time display,  
- dashboard auto-refresh,  
- BAMS poll cadence,  
- BAMS historical refresh cadence,  
- notifications,  
- privacy mode,  
- log level.  
Suggested auto-refresh:  
- Off  
- 1 min  
- 5 min  
- 15 min  
Suggested BAMS polling:  
- 60 sec  
- 2 min  
- 5 min  
- 10 min  
- custom  
Changing UI refresh must not change backend BAMS polling unless that setting explicitly controls polling.  
40. Logging  
Create application logs in a predictable local location.  
Log:  
- startup,  
- DB path,  
- schema migration,  
- API errors,  
- schedule sync classifications,  
- BAMS provider connect/disconnect,  
- monitor state,  
- backup operations,  
- migration/import outcomes.  
Do not log:  
- authentication tokens,  
- BSSO cookies,  
- full authenticated internal pages,  
- sensitive secrets.  
Handle local browser disconnects gracefully.  
Examples that must not produce scary tracebacks:  
- BrokenPipeError  
- ConnectionResetError  
- ConnectionAbortedError  
- Windows socket 10053  
- Windows socket 10054  
These should be debug/info-level connection lifecycle events if the application state is otherwise safe.  
41. Schedule Sync Failure Transport Behavior  
Expected schedule-source failures are normal operational outcomes, not HTTP-server crashes.  
If schedule sync fails because of:  
- BSSO,  
- CMS shell,  
- parser mismatch,  
- access denied,  
- network error,  
return structured JSON such as:  
{  
  "ok": false,  
  "classification": "cms_shell",  
  "error": "TEAM/CMS responded but schedule content was not present.",  
  "cached_schedule_active": true,  
  "diagnostics": {}  
}  
Do not throw this into a generic uncaught POST exception.  
The frontend should:  
- show a restrained error/toast,  
- preserve cached schedule,  
- invite user to open Diagnostics.  
42. Application State Contract  
Prefer a consolidated /api/state response for first load containing enough information to render:  
- accounts,  
- tasks,  
- notes/activity,  
- contacts,  
- operations schedule,  
- server upgrades,  
- BAMS state summary,  
- settings/runtime metadata.  
For large BAMS history, use dedicated endpoints rather than loading all samples into initial state.  
The frontend should have a clear state/repository boundary.  
Do not scatter raw API calls and ad-hoc mutable globals through every component.  
43. Accessibility  
Requirements:  
- semantic buttons,  
- semantic tables,  
- labels for form controls,  
- visible keyboard focus,  
- keyboard-accessible custom dropdowns,  
- dialog focus handling,  
- escape-to-close where appropriate,  
- sufficient contrast,  
- icons must not be the only communication mechanism,  
- prefers-reduced-motion support.  
44. Responsive Behavior  
The primary target is desktop Windows/Chrome/Edge.  
Still support narrower browser windows intelligently.  
Do not simply stack every element into an enormous vertical page.  
At smaller widths:  
- keep navigation understandable,  
- collapse secondary context before primary work,  
- allow tables horizontal scrolling,  
- preserve Today work queue,  
- preserve Account tabs,  
- preserve Operations queue/filter usability.  
45. Performance  
- Do not poll BLPAPI from the browser.  
- BAMS monitor runs in the Python process.  
- UI reads cached/latest BAMS state.  
- Avoid loading all historical BAMS samples on every refresh.  
- Paginate/limit very long audit/activity histories.  
- Keep local UI responsive with hundreds of tasks/notes/server upgrades.  
- Bulk Operations import should be limited and validated before apply.  
46. Security / Privacy  
This is a local workstation tool.  
Requirements:  
- bind only to loopback (127.0.0.1),  
- do not expose the local API to LAN by default,  
- no embedded secrets,  
- no credentials in frontend code,  
- sanitize HTML output,  
- validate file uploads,  
- restrict accepted bulk file type to .xlsx,  
- validate database paths and imported files,  
- protect DEV-only routes,  
- do not store BSSO auth material.  
47. Windows Packaging  
Provide:  
Launch_TAM_Command_Center.bat  
Launch_DEV_Preview.bat  
Install_Dependency.bat  
Check_PROD_Environment.bat  
Check_DEV_Environment.bat  
requirements.txt  
README.txt  
VERSION.txt  
VALIDATION.txt  
Launcher resolution order may be:  
1. TAM_PYTHON  
2. app-local .venv  
3. python  
4. py -3  
Require Python 3.10+.  
DEV launch can set:  
TAM_DEV_MODE=1  
TAM_BAMS_TEST_MODE=1  
Production must clear/ignore test flags.  
48. Dependency Philosophy  
Keep dependencies minimal.  
Required:  
- openpyxl>=3.1.2  
BLPAPI:  
- workstation/environment-specific,  
- do not blindly install an incompatible wheel,  
- environment check should report whether available.  
If using React:  
- compile and ship static assets.  
- production user should not need Node.  
49. Product Behaviors to Avoid  
Do not introduce these regressions:  
- native white browser buttons inside dark UI,  
- native ugly select popups as the primary interaction,  
- disconnected account context cards that feel unrelated,  
- a separate Journal section that fractures account history,  
- artificial account-health scores,  
- commercial/sales pipeline fields,  
- application inventory/CMDB scope,  
- Client Notice in the Operations progression,  
- hard-coded 2026-only schedule logic,  
- overwriting cached schedule on failed sync,  
- automatically closing recovered BAMS alerts,  
- duplicate server records on repeated bulk imports,  
- automatic AI writeback without preview,  
- Production fallback to simulated BAMS.  
50. Development Workflow / Documentation Discipline  
Maintain these files in every development branch:  
TAM_PROJECT_STATE.md  
CHANGELOG.md  
Rule  
Every substantive:  
- code change,  
- config change,  
- schema change,  
- deployment change,  
- behavior change,  
must update both.  
TAM_PROJECT_STATE.md  
Describe:  
- current release,  
- architecture,  
- environment separation,  
- schema,  
- current source manifest,  
- completed behavior,  
- current work item,  
- validation,  
- next steps.  
It is the current truth, not a chronological transcript.  
CHANGELOG.md  
Keep durable history.  
New development should go under:  
Unreleased  
or a clearly identified DEV release section until finalized.  
Before Production promotion:  
- DEV validation must explicitly pass.  
51. Recommended Implementation Phases  
Phase 1 — Foundation  
Build:  
- local HTTP server,  
- SQLite schema/migrations,  
- Accounts,  
- Tasks,  
- Notes,  
- Contacts,  
- audit,  
- backup,  
- Settings,  
- core navigation/design system.  
Phase 2 — CRM Workspace  
Build:  
- Today prioritized queue,  
- Accounts directory,  
- Account Workspace,  
- Overview,  
- Tasks,  
- Activity,  
- Infrastructure,  
- Contacts,  
- Quick Capture.  
Phase 3 — Operations  
Build:  
- quarterly release schema,  
- schedule source adapter,  
- future-year parser,  
- sync/cache/fallback,  
- diagnostics,  
- server upgrade CRUD,  
- next-weekend logic,  
- working queue,  
- bulk template/import.  
Phase 4 — BAMS  
Build:  
- BLPAPI provider,  
- simulated DEV provider,  
- object/metric config,  
- polling,  
- historical values,  
- rules,  
- alert lifecycle,  
- notifications,  
- global BAMS UI,  
- account integration.  
Phase 5 — Data Portability  
Build:  
- Excel import/export,  
- DB backup/download,  
- migration,  
- restore,  
- ChatGPT Bridge.  
Phase 6 — Hardening  
Build/test:  
- process lock,  
- Production mode,  
- DEV isolation,  
- logging,  
- Windows launchers,  
- environment checks,  
- schema backup,  
- browser disconnect handling,  
- packaging.  
52. Acceptance Tests  
The implementation should not be considered complete until these scenarios pass.  
Today  
- overdue task appears before normal upcoming task.  
- active BAMS alert appears as actionable.  
- near-term upgrade appears in queue.  
- clicking a queue item navigates correctly.  
Account Workspace  
- account opens from Accounts.  
- Overview shows top open tasks.  
- Tasks tab filters to account.  
- Meeting Note create/edit/delete works.  
- Call Note create/edit/delete works.  
- General Note create/edit/delete works.  
- Activity filters correctly.  
- system events are distinct.  
- contact Primary behavior works.  
- Infrastructure shows BAMS and upgrade records.  
Operations  
- future-year schedule parser accepts a 2027 fixture without code changes.  
- schedule parser supports West-first and East-first quarters.  
- failed sync preserves cache.  
- BSSO page classified auth_required.  
- CMS shell classified cms_shell.  
- malformed schedule with valid headers classified parser_mismatch.  
- network failure classified network_error.  
- next upgrade weekend selects earliest future event.  
- Client Notice absent.  
- server CRUD derives date/version correctly.  
- account dropdown filters server queue.  
- bulk template contains current accounts.  
- preview catches invalid account.  
- PROD requires polarity.  
- DEV normalizes to DEV.  
- repeated bulk import updates instead of duplicating.  
BAMS  
- provider failure fails closed.  
- test provider works only in DEV.  
- polling cadence respected.  
- repeated breach updates one event.  
- recovery does not close alert.  
- manually closed alert does not reopen until clear.  
- stale provider outage does not create storms.  
- Windows notification can be disabled/privacy-mode controlled.  
Safety  
- DEV cannot open Production mode.  
- second process using same DB is blocked.  
- DB backup succeeds under WAL.  
- destructive actions create backup.  
- imported malformed workbook does not partially write.  
- no DB is shipped in release archive.  
53. Suggested Folder Layout  
A clean rebuild could use:  
TAM_Command_Center/  
│  
├─ server.py  
├─ bams_backend.py  
├─ requirements.txt  
├─ README.txt  
├─ VERSION.txt  
├─ VALIDATION.txt  
├─ TAM_PROJECT_STATE.md  
├─ CHANGELOG.md  
├─ OPERATIONS_SERVER_UPGRADE_GUIDE.txt  
├─ CRM_WORKSPACE_GUIDE.txt  
│  
├─ web/  
│  ├─ index.html  
│  ├─ app.js  
│  ├─ styles.css  
│  └─ assets/  
│  
├─ dev_data/  
│  └─ (runtime-created tam_dev.db; do not package real data)  
│  
├─ Launch_DEV_Preview.bat  
├─ Launch_TAM_Command_Center.bat  
├─ Install_Dependency.bat  
├─ Check_DEV_Environment.bat  
└─ Check_PROD_Environment.bat  
If using React, replace web/ internals with a compiled frontend output but keep the end-user runtime simple.  
54. Design System Notes  
Use reusable tokens for:  
--bg  
--surface-1  
--surface-2  
--surface-3  
--border  
--text  
--muted  
--accent  
--danger  
--warning  
--success  
--info  
Use:  
- tabular numerals for metrics/dates,  
- small uppercase labels for technical metadata,  
- clear monospace only where identifiers benefit,  
- restrained border radii,  
- almost no decorative gradients,  
- hover states based on contrast/border rather than large movement.  
Tables:  
- sticky header when useful,  
- aligned dates/numbers,  
- subtle row hover,  
- compact status badges,  
- no excessive badges.  
55. Final Product Principle  
Do not build a generic CRM.  
Build a Technical Account Manager command center where:  
Today tells me what to do.  
Account Workspace tells me everything relevant about one client.  
Operations tells me what infrastructure change is coming.  
BAMS tells me whether the infrastructure is healthy.  
Activity tells me what happened and what I discussed.  
Tasks tell me what remains outstanding.  
The experience should be fast, clear, operational, and trustworthy.  
When forced to choose between:  
- more decorative UI,  
- or clearer operational context,  
choose clarity.  
When forced to choose between:  
- additional CRM complexity,  
- or faster TAM execution,  
choose faster TAM execution.  
When forced to choose between:  
- live data that may be wrong,  
- or cached data clearly marked as cached,  
choose safe cached data and expose diagnostics.  
56. Build Completion Deliverables  
Return:  
1. complete runnable source,  
2. Windows launchers,  
3. environment preflight,  
4. DB migration logic,  
5. schema definition,  
6. frontend design system,  
7. DEV build,  
8. Production-safe build after validation,  
9. README,  
10. CRM guide,  
11. Operations guide,  
12. validation report,  
13. project state,  
14. changelog,  
15. build manifest with SHA-256 hashes,  
16. screenshots of:  
    - Today,  
    - Account Overview,  
    - Account Activity,  
    - Operations,  
    - Bulk Upload,  
    - BAMS.  
Do not call the build Production-ready until the workstation-specific Bloomberg API and TEAM/BSSO behaviors have been validated on the target Bloomberg Windows environment.  
