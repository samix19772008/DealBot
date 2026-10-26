# From a working bot to a useful product

DealBot's current niche is a Discord gaming marketplace: one agreed payment, a private conversation, clear hand-offs, and evidence for moderators. Its value depends on traders completing real transactions and returning to use it. English commands and more features alone do not demonstrate demand.

## What this release prepares

- Independent server configuration, reputation, local staff decisions, and aggregate statistics.
- Local earned points separated from staff-assigned ranks. A server cannot confer or remove reputation in another server.
- Repeated trades between the same pair earn points at most once per rolling 24 hours per server. Completed deals still count in history. This limits one farming pattern; it does not establish real-world identity or eliminate alternate accounts.
- Pending-request expiry, durable request cooldowns, and atomic limits tested with concurrent processes.
- A setup diagnostic, auditable flag corrections, private offer defaults, and verified SQLite backups.
- A simple Request a Deal buying route, a zero-option `/deal` guide, and administration grouped under `/setup`.
- An owner-only deal dashboard with filters and navigation, short private-thread names, and permission-checked recovery of archived active conversations.
- Independent server-controlled policies for active conversation hiding and finished cleanup. Active hiding archives without locking or ending a deal; finished cleanup locks and archives with a final transcript. Disputes are excluded from active hiding, and durable jobs survive restarts.
- Optional global command registration for installations in multiple servers. This was validated with simulated REST calls; no live global registration was performed during development.

## Private acceptance first

Complete [the private acceptance run](PRIVATE_ACCEPTANCE.md) in a nonpublic test server before announcing the bot. The owner, buyer, seller, and staff can exercise the real application without exposing an unfinished rollout to a community. Include several simultaneous trades, dashboard privacy, active hiding without completion notices, independent policy switches, delayed cleanup after new messages, the shared armour-set post, and archived-conversation recovery. Offline tests, container checks, and source publication do not complete the Discord checks in that run.

## After private acceptance

Start with three gaming-market communities whose moderators can actively participate, for roughly one month. Help each administrator run `/setup check`, verify a representative deal and dispute in their own server, and explain that payment checks remain the participants' responsibility.

Review `/setup stats` weekly with each community. It reports the number of requests opened in that server over the last 30 days, their current statuses, distinct traders, and a clearly defined completion rate. Capture user feedback separately: where they abandoned the form, why an invitation was rejected, and whether they returned for another purchase. Avoid adding another command until a recurring problem explains its value.

The stats command cannot yet prove trader retention or measure time-to-resolution, acquisition, moderation cost, or revenue. Its completed/opened ratio includes pending and cancelled requests; use the counts alongside it rather than treating it as a seller quality score. Payment alternatives are not summed or converted.

## Before a broad public launch

1. Move the bot from a local development terminal to an operator-managed service with restart supervision, restricted credentials, and monitored availability. Do not infer 24/7 service from a successful local run.
2. Schedule the online database backup command, retain copies away from the host, and practice restoring one. The included command creates local snapshots; it does not configure off-machine storage or disaster recovery.
3. Publish an actual support contact and decide data-retention and correction procedures. Private threads, moderation decisions, and DM transcripts are sensitive records. Source publication alone does not provide a support operation or a privacy policy.
4. Complete Discord's applicable app-verification and privileged-intent requirements as installations grow. The app currently requests Server Members and Message Content for its existing workflow; current requirements must be checked in the Developer Portal.
5. Load-test the expected workload and review thread limits, rate limits, storage growth, and the single SQLite database. Private threads, active-conversation hiding, and finished-thread archiving reduce sidebar clutter; they do not remove Discord's limits. Cleanup runs in batches of five approximately once per minute and may take longer when there is a backlog. These development tests do not establish multi-host scalability or shard readiness.
6. Verify the durable transcript queue and private recovery flow on the installed bot. New finished-deal archive observations save work and individual outcomes in SQLite; failed deliveries resume with bounded backoff, and `/transcript` can retrieve a captured file. Gateway events missed while the bot was offline are not discovered by scanning all historical threads. Reopened/deleted sources may prevent capture; closed DMs and ambiguous send acknowledgements still limit delivery guarantees. Monitor exhausted retries and storage growth, and choose retention for private HTML artifacts.

The accurate product description is **deal coordination and dispute records for Discord communities**. DealBot does not hold, transfer, verify, insure, or refund funds. Financial custody would require a separate payment integration and operational design, not a label change.

Broader adoption should follow repeat usage and dependable moderation. None of the changes in this release guarantees growth, profit, fraud prevention, or a safe trade.
