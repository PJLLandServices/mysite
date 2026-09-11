# PJL Field: offline-saving release

This release needs a new iPhone build through the Mac and Xcode. Adding
`expo-sqlite` changes the native fingerprint. Do not publish it as an update
for the old build or bypass the existing update checks.

## What changes

- Work-order edits and property-system corrections are recorded in SQLite
  on the phone before an upload is attempted.
- Zone drafts survive navigation and restart without being marked reviewed.
- Photo bytes remain on the phone until the server acknowledges them.
  A persisted upload identifier prevents duplicate attachments on retry.
- Previously opened work orders and a previously loaded schedule can be read
  offline. The open work order is restored after restarting the app.
- While the app is active, pending work retries every 15 seconds and when
  the app returns to the foreground. No iOS background execution is promised.
- Conflicting office edits are not silently overwritten. The local evidence
  stays on the phone with an explanation; resolve the record and tap retry.
- Sign-off can be captured and retained locally, but completion and invoicing
  require connection and an empty outbox. No automatic payment, invoice send,
  customer message, signature bypass, or completion replay was added.

The header distinguishes `Draft on phone`, pending uploads, and `Synced`.
`Synced` describes recorded work, not whether all required visit questions
have been answered. Photo previews can display before upload finishes.

## Boundaries to understand

- A new work order still has to be created online. Open the day's work orders
  before leaving coverage. This release does not create provisional offline
  customers, bookings, work orders, or invoices.
- Adding or removing the property's zone list still needs connection. Zone
  assessments, drafts, photos, and label corrections use the local store.
- The cache is per signed-in staff account. Known authentication failures
  do not fall back to another user's cached records. A network outage permits
  the last verified staff account to reopen its own local work.
- Previously uploaded server photos are not downloaded as offline files.
  Newly captured pending photos are stored on the phone.
- Deleting the app deletes its local storage. Do not uninstall it to fix a
  problem while work is pending.
- The repair transfer endpoint clears issues from the work order. It now runs
  during connected completion, after queued edits have drained, so stale
  queued zones cannot put transferred issues back. Until then, findings stay
  with the visit. This endpoint's existing partial-failure behavior has not
  been redesigned; production acceptance must verify transfer into the property.

## Release order

1. Review the pull request and automated results. Plan the iPhone test window
   before approving deployment; the new server support must be available for
   the final sync test. Keep the existing app installed until the new build is ready.
2. Merge the approved server/app changes. Wait for Render's deployment to
   finish. The server must support `fieldOffline.photoRetry` before this app
   will upload queued photos.
3. On the Mac, use the same repository checkout that builds the iPhone app.
   Check its branch and uncommitted changes before pulling. Do not discard
   local Mac edits to force an update.
4. After that checkout is on the updated main branch, open Terminal in the
   repository folder and run these commands separately:

   ```sh
   cd pjl-field
   ```

   ```sh
   npm ci
   ```

   ```sh
   npm run rebuild
   ```

   Wait for `REBUILT AND READY`, or follow the specific setting it reports.
   The rebuild restores the signing team and Release configuration where it
   can. It requires the existing Mac/Xcode/CocoaPods setup.

5. The rebuild prints an `open ...xcworkspace` command. Run that exact line.
   Open the white workspace icon, not the blue project icon.
6. Plug in and unlock the iPhone. In Xcode select the phone as the destination
   and press Run. Let installation finish, then open PJL Field on the phone.
7. Sign in if asked. Test a clearly labelled test work order before field use.

The actual `git` update commands should be supplied after checking the Mac's
folder and branch. A guessed path or blind branch switch is not appropriate.
Patrick does not need to run any build or upload commands on Windows.

## Required iPhone acceptance

Use test records. Do not send a customer invoice or message as a connectivity test.

1. Open the schedule and a test fall work order online.
2. Enter airplane mode. Record a customer note, change a zone note, record
   a zone outcome, take a photo, and correct a property-system location.
3. Move between zones and stages. Confirm draft text is retained.
4. Force-close the app and reopen it. Confirm the open work order, notes,
   draft, and pending photo remain available.
5. Reconnect and leave the app open. Confirm the pending count clears and
   the CRM has the same text and property correction, plus one copy of the photo.
6. Repeat with slow connection and rapid typing. The newest text must survive.
7. Change the same field from the office while a phone edit is pending.
   Confirm the phone retains its evidence and does not overwrite the office.
8. Capture sign-off offline; confirm the visit is not represented as completed.
   Reconnect and use Retry recorded sign-off. Verify the property findings,
   service report, work-order state, and single draft invoice.
9. Repeat completion with nobody home. Interrupt after bypass if possible,
   then verify retry can continue from the recorded bypass.
10. Confirm larger text, keyboard visibility, photo previews, and cold-start
    loading on the actual iPhone. A Windows bundle export cannot validate these.

## Automated verification

New tests run the real queue and native API bridge with controlled storage and
HTTP responses, plus the photo-retry helper. They cover restart recovery,
ordered edits, conflicts, lost acknowledgements, account boundaries, retained
photos, and completion gates. Native SQLite and iPhone lifecycle behavior
still require the device checks above.

The first baseline run had 10 failing offline tests (module absent), four
failing photo-retry tests (helper absent), and the previously reproduced three
save races. The new suites contain 26 passing cases. The Windows atomic-file
test initially failed on EPERM; bounded retries of the same atomic rename
resolved it without changing Linux behavior or falling back to truncation.
