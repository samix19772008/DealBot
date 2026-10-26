# Private acceptance before announcement

Use a private Discord test server with the owner, one buyer account, one seller account, and a staff role. No public audience or real payment is needed. Label test products clearly. These are operator checks to run on the installed application; automated offline tests do not mark them complete.

Record the release commit, host, date, tester, and observed result for each row. Resolve failures and repeat the affected flow before announcing the bot.

| Check | Expected observation | Result |
| --- | --- | --- |
| Private installation | Register guild commands for the test server, keep global registration for a later decision, and run `/setup`. Required hub and staff checks pass | Pending |
| Decorated products | Post separate rank headings with USD and stack prices, descriptive prose, custom emojis, and mentions. `Preview Listing` shows separate ranks, correct prices, and no notification pings | Pending |
| Packs | Post `3 Books = 2 Sky1 Notchs` and `9 Books = 5 Sky1 Notchs`. Two packs of the latter produce 18 books for 10 Sky 1 Notchs | Pending |
| Stack remainders | `5.32 Stack` produces 352 individual units; `1.20 Stack` produces 84; a leftover count of 64 is rejected | Pending |
| Offer boundaries | Each product exposes only its own payment methods; ambiguous duplicate names/prices need clarification; `Stock: 0` cannot be ordered | Pending |
| Source edits | Open a picker, edit or delete the source post, then submit the old form. It refuses stale terms and asks to reopen | Pending |
| Completion | Buyer requests, seller accepts, both enter the private thread, and the designated buyer/seller controls advance payment, delivery, and receipt exactly once | Pending |
| Cancellation and expiry | A pending request can be cancelled by its participants. A previously accepted deal cannot be cancelled by a stale pending form | Pending |
| Dispute | A participant explains a dispute; ordinary users cannot resolve it. The configured staff can view the private thread and resolve it with an audited decision | Pending |
| Private offers | Close seller DMs and request through the market post. It cancels privately instead of leaking offer details to the hub | Pending |
| Archive delivery | Reopen seller DMs, finish a new deal, archive it, and verify both participants receive the purple summary and HTML file with the correct closer and time | Pending |
| Closed-DM recovery | Close one participant's DMs before a new archive. The other still receives the record. Reopen DMs and wait for a due retry; `/transcript` also privately downloads a captured file | Pending |
| Evidence access | An unrelated user and a participant in another server cannot retrieve the transcript. The designated local staff can retrieve it | Pending |
| Restart | Restart the service during a pending request and with queued delivery work. Saved deals and pending outcomes survive; confirmed recipient outcomes are not intentionally sent again | Pending |
| Health | `npm run health` reports healthy while connected. Stopping or disconnecting the bot stops that healthy report; the supervisor restarts an unexpected process exit | Pending |
| Backups | Enable one backup scheduler, confirm a private snapshot is created, and run `npm run db:verify-backup -- /path/to/snapshot.sqlite`. Isolated recovery passes without changing the original | Pending |
| External recovery copy | Copy a verified snapshot away from the bot host using operator-controlled protected storage, then verify that copy. Local snapshots alone do not survive host loss | Pending |

Before public use, choose a support contact, moderation/appeal process, and retention policy for stored conversations, source posts, and backups. The release deliberately does not publish an invented contact or delete old evidence automatically. Confirm any applicable Discord app-verification and privileged-intent requirements in the Developer Portal.

The recovery command rehearses migrations on a disposable copy. A live restore is a separate operator action: stop the bot, preserve the current database and its WAL/SHM sidecars, restore or select the verified database, check ownership, start one instance, and repeat `/setup`, `/deal-status`, and the health check. Do not overwrite a running SQLite database or run two installations on the same file.

DM retries are bounded and can be delayed after an interrupted worker lease. Stable nonces reduce duplicate sends within Discord's deduplication window; no crash-safe exactly-once delivery claim is made. A source reopened or removed before capture may have no saved HTML. `/transcript` can retrieve only an artifact that was actually captured.
