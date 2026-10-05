# Enviroweather Fleet team review

Review URL: https://atolldb.com

Use a separate invited account. Start with viewer access. Any editor exercise should use a new record titled `TEST — Team review`, a synthetic station name, and invented readings. Preserve real records and take an authenticated Export backup before testing edits.

| Requirement | Current control | Reviewer exercise |
| --- | --- | --- |
| Provider keys remain private | Synoptic calls run in the Cloudflare Worker with a secret binding; public assets contain no configured token | Inspect page source and browser requests. Synoptic requests should not originate from the browser. App requests contain the reviewer's session token, which is distinct from the provider key. |
| Maintenance information stays private | Every data, QC, record, visit, handoff and export route requires an active account | Open the site while signed out. Direct API data requests should return 401 without station notes or QC. |
| Roles are enforced by the server | Viewers read/export; editors edit records; only the owner manages invitations and access | Attempt writes as a viewer and access management as an editor. Expect 403. Changing a requested invitation role does not create an owner. |
| Evidence survives edits | Evidence is append-only; edits require the current revision | Open the same synthetic record twice, save one, then save the other. Expect a conflict; the saved record should retain the first update. |
| API outages remain visible | A failed refresh retains the last successful snapshot and original fetch time | The automated outage tests simulate an unavailable provider and partial refresh. During a real outage, verify the warning and older timestamp; do not interpret an empty result as zero. |
| Access can be revoked | Disabling a member and changing a password delete existing sessions | Have the owner disable the review account, then try to reload its workspace. Expect sign-in to be required. |
| Field work is not invented | Visit plans create new local drafts and do not fill readings or check off work | Review a synthetic visit plan. Verify that readings, arrival time and performed-work checks remain blank. |
| Data can be recovered | Authenticated shared-record export and local notebook/photo backup | Export synthetic records and notebook data. Verify the files can be read and the local notebook can be restored in a disposable browser profile. |

Record each issue with the action, expected behavior, actual behavior, timestamp, account role, browser/device, and a screenshot with credentials removed. Assign pass/fail to each exercise. Log defects as private team cases; do not put real station notes in public GitHub issues.

Pending review: a teammate has not performed this acceptance test. Teams Graph uploads, Flyspray, internal MSU APIs, and LoggerNet remain unconnected. Shared photos remain local. The removed historical maintenance examples have been cleaned from main-branch history and their old build runs. A private Git bundle preserves the original history. GitHub retains the old direct commit URL; its removal still requires GitHub Support.

Review the Anomaly report and Reference tracker with a station whose nearby histories are available. Check variable, radius, minimum references, tolerance, coverage, observation and fetch times, QC exclusions, and failed sources. Download the report and verify all observations and reference memberships are retained. Outside-range findings need human review of weather, site exposure and sensor placement.
