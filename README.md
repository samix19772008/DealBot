# DealBot · English edition

Buy from a Discord market post, agree on its listed price, and follow payment and delivery buttons in a private conversation. DealBot keeps a deal record, local reputation, and evidence for moderators. All built-in messages are in English; seller descriptions and member messages are preserved.

DealBot records confirmations. It does **not** hold, transfer, verify, or refund payments. The seller checks payment independently; the buyer checks delivery before confirming receipt.

## Use the bot

1. Open the menu on the seller's post: **Apps → Request a Deal**.
2. Choose the product or pack, one of its offered payment methods, and the quantity. The bot calculates the total.
3. The seller accepts the private request. Follow the payment, delivery, and receipt buttons in the private conversation.

Use `/deal` if you need these instructions and a **My Deals** button. It has no seller, price, or payment form. **Request a Deal** is the buying route; buyers cannot replace the seller's detected prices.

**My Deals** opens your private dashboard. Select a deal, then **Open Conversation** to continue. **Hide Conversation** puts an active conversation away for both participants without ending the deal. **Download Transcript** in finished deal details retrieves a file if it has been captured.

Sellers can keep descriptive text, mentions, emojis, enchantments, and several products in one post. Use **Apps → Preview Listing** on your own post to check the detected offers. See [post examples and parsing limits](docs/LISTING_FORMAT.md).

## Update to version 1.8

1. Stop the old bot. Keep only one running process for the installation.
2. Back up `.env` and `data/`, including SQLite WAL/SHM sidecars if present.
3. Copy in the new source files while keeping your existing `.env` and `data/`.
4. Use **Node.js 24 LTS** and install the dependencies in that folder:

   ```sh
   npm ci
   ```

5. After installation succeeds, refresh the commands and start the bot:

   ```sh
   npm run commands:deploy
   npm start
   ```

Version 1.8 replaces the long `/deal` form with the buying guide and My Deals button, groups administration under `/setup`, and adds active-conversation hiding. Command refresh removes the retired top-level commands. It also recognizes shared armour-set prices such as `1 Set : 32 <:redstone_dust:...>` and `10 Sets : 4 <:gold:...>` without treating individual helmet, chestplate, leggings, boots, or sword stock as complete-set stock.

Startup adds missing columns and queues without deleting existing deals, profiles, settings, or saved transcripts. Existing literal amounts and units remain unchanged. Reputation and flags are server-specific; earlier unscoped manual ranks or flags are not copied into every server. Review any needed local override with `/setup rank`. Manual migration scripts are unnecessary.

## New installation

Install Node.js 24 LTS, run `npm ci`, copy `.env.example` to `.env`, and fill in these values locally:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `CLIENT_ID` | Application ID for command registration |
| `GUILD_ID` | Server ID for the default server-only registration |
| `DATABASE_PATH` | Optional SQLite path; defaults to `data/escrow.sqlite` |
| `BACKUP_INTERVAL_HOURS` | `0` disables scheduled backups; `1`–`168` enables verified startup and interval snapshots. Deployment examples use `24` |
| `BACKUP_DIRECTORY` | Optional snapshot directory; defaults to `backups/` beside the database |
| `HEALTH_STATUS_PATH` | Optional heartbeat path; defaults to `health.json` beside the database |

Enable **Server Members Intent** and **Message Content Intent** in the Developer Portal. Install with the `bot` and `applications.commands` scopes. The bot needs these hub permissions:

- View Channel, Send Messages, Embed Links, Attach Files, Read Message History.
- Create Private Threads, Send Messages in Threads, Manage Threads.
- Manage Roles only for optional cosmetic trust roles, which must be below the bot's highest role.

Participants need View Channel, Read Message History, and Send Messages in Threads. The configured staff role needs those permissions plus Manage Threads to access private disputes. Do not grant Administrator to the bot just for setup.

Run `npm run commands:deploy` and `npm start`. In Discord, an administrator chooses `/setup hub channel:#escrow-hub`, `/setup staff role:@EscrowStaff`, then `/setup check`. A dispute needs a configured staff role with effective thread access.

## Commands

Most members only need **Request a Deal** and the buttons. Nine definitions are registered: seven slash commands and two message-menu actions.

| Command or action | Use |
| --- | --- |
| Message → Apps → Request a Deal | Buy a listed product or pack at its detected price |
| Message → Apps → Preview Listing | Seller-only preview of products, prices, packs, stock, and warnings |
| `/deal` | Simple buying guide and My Deals button; no form options |
| `/deals` | Open your private dashboard directly |
| `/help` | Short guide to buying, tracking, and disputes |
| `/profile user` | View a member's reputation and rank in this server |
| `/deal-status reference` | Advanced recovery: inspect details and restore buttons inside the original thread |
| `/transcript reference` | Advanced recovery: privately download an available saved conversation file |
| `/setup` | Administrator-only grouped configuration and diagnostics |

Administrator actions are grouped under `/setup`: **check**, **hub**, **staff**, **threads**, **rank-role**, **rank**, **review-flag**, and **stats**. The retired `/set-*`, `/stats`, `/review-flag`, `/ping`, and `/listing-format` definitions are no longer separate entries after refreshing commands. English is fixed; no language command is needed.

Every command requires a server. The dashboard shows only the requesting user's deals in that server. Participants and authorized local staff can inspect a deal or retrieve its evidence; another server's configuration and reputation do not grant access.

## Prices and quantities

Each listed payment method is an alternative, not an exchange rate. Money is USD with at most two decimal places. A stack contains 64 items. In post prices, **`5.32 Stack` means 5 stacks plus 32 items = 352**, and `1.20 Stack` means 84. The digits after the dot are a leftover count from 0 to 63; `.2` means 2 items.

Quantity counts the selected pack. Two packs of `9 Books = 5 Sky1 Notchs` mean 18 books for 10 Sky 1 Notchs. Shared set prices can offer `1 Set : 32 Redblocks` and `10 Sets : 4 Golds` as separate choices. Component stock does not establish the number of complete sets available.

Text parsing runs locally and needs no external AI API key. It supports clear text structures, not every sentence or image-only/embed-only prices. Contradictory prices are omitted or rejected. Preview the original post and detected terms before accepting. Positive stock is advertised information; the bot does not reserve or decrement inventory. `Stock: 0` prevents ordering that offer.

Pickers are bound to the buyer and server, survive a restart, and expire after 15 minutes. Source edits or deletions require reopening the picker. Created requests keep their selected terms and original source text; later post edits do not rewrite them. Full supported examples and limits are in [the listing guide](docs/LISTING_FORMAT.md).

## Deal steps and recovery

The seller receives the request by DM. If DMs are closed, it cancels privately without exposing the item and payment in the hub. After acceptance, the buyer confirms payment sent, the seller independently verifies it and confirms delivery, and the buyer verifies receipt and completes the deal. Either participant can open a dispute; only authorized local staff can resolve it.

Each completed deal counts once for both participants in this server. A pair can earn 5 trust points each at most once per rolling 24 hours here; repeated completed deals still count, without extra points during that interval. Cosmetic rank roles are optional.

Use **My Deals** to find a request, next action, or conversation. For missing action buttons, run `/deal-status` inside the original thread. Pending request controls also work elsewhere in the same server for the designated participant. State changes are checked again, so stale buttons cannot repeat rewards or replace an incompatible state.

Each buyer can have up to 10 active deals and send one new request every 15 seconds per server. Pending offers expire after 24 hours. These are persisted limits; they do not expire accepted or disputed deals. Quantity is 1–999 packs, with validated payment totals. Money cannot exceed `9,999,999,999.99`; game payments cannot exceed `9,999,999,999` individual items, including stack multiplication.

## Keep the hub organized

Each accepted deal keeps its own private thread so different participants and records remain separate. Names such as `deal-0042-menace-cape` are short. Discord does not provide a separate thread folder for each trader; authorized staff can see more private threads than an ordinary participant.

**My Deals** or `/deals` shows up to six entries per page with Active, Needs your action, Completed, and All filters. Select a deal for its full details and **Open Conversation**. Current permissions and private-thread membership are checked before reopening; removed participants are not added back. Ordinary participants cannot unlock a staff-locked thread. Authorized local staff also need current Manage Threads permission. Finished conversations are not reopened through this button.

Two independent policies reduce the active thread list:

| Conversation | Default | Effect |
| --- | --- | --- |
| Accepted active deal awaiting payment, delivery, or receipt | 15 minutes without activity | Archive without locking or ending the deal; no completion transcript DM |
| Completed, cancelled, or refunded deal | 30 minutes without activity | Lock and archive; queue the final transcript |

Pending requests and disputed deals are excluded from automatic active-conversation hiding. A participant can also use **Hide Conversation** for an eligible active deal. Hiding archives the shared conversation **for both participants**, keeps its messages, and leaves its deal status unchanged. Reopen through **Open Conversation** when needed.

An administrator configures the policies with `/setup threads idle-after` (Off, 5, 15, 30, or 60 minutes) and `/setup threads archive-after` (Off, 15, 30, 60, or 1,440 minutes). Turning one off does not disable the other. New messages and a reopening restart the relevant idle interval. Workers check approximately once per minute in bounded batches, so a backlog can delay archiving. Native Discord inactivity archiving remains separate and never completes a deal.

Cleanup progress survives restarts. Already archived history is not exported again by a scan. No policy deletes a thread, deal, saved transcript, or backup. Actively used conversations can still appear simultaneously; these controls reduce clutter without mixing unrelated trades.

## Transcript cards

![Illustrative transcript DM card](docs/transcript-preview.svg)

After a finished deal conversation is archived, both participants receive a purple summary card with the server's icon, item, reference, buyer, seller, agreed payment, closer, and closing time. Names and IDs use clear code-block fields, similar to a ticket transcript. **View Deal** opens the original private conversation; the HTML conversation transcript is attached to the same DM. The file uses the item name, such as `transcript-menace-cape-42.html`.

The closer is recorded before an archive request and confirmed using Discord's archive timestamp. Participant approval and moderator closure retain their actual actor. Finished-thread cleanup identifies DealBot as the automatic closer. Archives made outside DealBot's close controls are labeled **Automatic archive or a Discord-side action**, since the bot cannot identify that actor from a thread update alone. Failed attempts and reopened threads do not inherit the wrong closer. REST and Gateway observations of the same archive share a delivery operation, including SDK cache races.

The preview is illustrative; Discord controls the theme and attachment preview. New finished-deal archives atomically queue capture work with their closure record. Archiving an active conversation for visibility does not send a completion transcript or create a new transcript job; any earlier captured file is retained. Captured HTML and summaries are saved in SQLite before sending. Each participant has independent delivery progress: only pending outcomes are retried after a restart. Upgrades do not scan and resend every historical closure. No saved HTML is invented for older archives.

Transient capture failures are retried up to 5 times. An honest summary can be sent first; if capture later succeeds, the HTML file follows separately. DM failures are retried up to 12 times with increasing delays from one minute to a maximum of 24 hours between attempts. A participant can select **Download Transcript** from finished deal details or use `/transcript reference:ESC-…` in the same server for an ephemeral download of a saved artifact; only participants and authorized local staff can retrieve it. Downloads do not falsely mark a DM as delivered. Stable Discord nonces reduce duplicate sends, but a crash after Discord accepted a message and before its acknowledgement was recorded can still produce a duplicate.

Exports include up to the latest 10,000 messages and must fit the 8 MiB artifact limit. Attachments remain links and depend on Discord availability. Capture retries verify that the source is still the same archived conversation before and after generation. A deleted or reopened source cannot be re-exported as an older archive; an already saved HTML artifact can still be delivered or downloaded. An auto-archive does not complete or cancel an active deal. The database now contains private HTML artifacts as well as deal records; backups include them. No automatic artifact deletion or retention policy is enabled. Monitor storage and choose a retention policy before public use.

## Multiple servers and operations

Run `/setup check` as an administrator in each server for a read-only health checklist. It explains required fixes and checks optional cosmetic rank roles. `/setup stats` gives private aggregate counts for deals opened in that server during the last 30 days, grouped by their current status. Completion rate means completed requests divided by all requests opened in that window. The current active count spans all dates. These metrics do not mix currencies, expose personal deal details, or claim verified sales revenue.

Single-server command registration remains the default. To register commands for all servers where the application is installed, use the optional global mode with `DISCORD_TOKEN` and `CLIENT_ID` configured:

```sh
npm run commands:validate:global
npm run commands:deploy:global
```

A `GUILD_ID` is not required for global registration. Every command still requires a server context and checks local permissions. Global command propagation is managed by Discord. Existing guild-specific definitions take precedence over global definitions in that guild; refresh those with `npm run commands:deploy` as well. Development only exercised offline definitions and mocked REST routes; live global registration must be performed by the operator.

For a consistent SQLite snapshot, including committed WAL data:

```sh
npm run db:backup
# Or choose a new output file without overwriting an existing backup:
npm run db:backup -- --output /path/to/new-backup.sqlite
# Rehearse restoration and current migrations on a private disposable copy:
npm run db:verify-backup -- /path/to/new-backup.sqlite
```

This uses SQLite's online backup API, opens the source read-only without running migrations, verifies integrity and foreign keys, and publishes a private standalone file. The default destination is a unique file in the database folder's `backups/` directory. It does not copy `.env`, upload backups, or schedule retention. To restore, stop the bot, preserve the current database and its sidecars, and point `DATABASE_PATH` at a verified backup before starting again. Keep recovery copies away from the host; a backup on the same disk alone is not disaster recovery.

For a persistent deployment, choose one method in [Operations](docs/OPERATIONS.md). Set `BACKUP_INTERVAL_HOURS=24` for the built-in startup/daily backup worker, or use the optional systemd backup timer with the built-in worker disabled. Local snapshots are not an off-host backup; configure your own protected external copies. `npm run health` reports a fresh local heartbeat, a live recorded process, and last-reported Discord readiness, plus aggregate transcript queue counts. Review nonzero `failedRecipients` and `unavailableArchives`; a healthy process does not mean every delivery succeeded. The command does not send a Discord test message or prove every command works. Shutdown stops new work, drains active handlers and workers, then closes SQLite. A stuck shutdown uses a bounded supervised exit instead of closing SQLite beneath active work.

Complete [private acceptance](docs/PRIVATE_ACCEPTANCE.md) before announcing the bot. See [the launch plan](docs/LAUNCH_PLAN.md) for later adoption questions and remaining hosting, support, privacy, and scale decisions. Global registration does not demonstrate global readiness.

## Development and checks

```sh
npm test
npm run check
npm run commands:validate
npm run commands:validate:global
npm run preview:transcript
npm run db:init
npm run dev
```

Tests use isolated temporary or in-memory databases and simulated Discord interactions. They do not log in, publish commands, or send messages. Coverage includes legacy migrations, scoped reputation, anti-farming rewards, audited decisions, atomic state changes, rollback, concurrent-process caps and cooldowns, privacy defaults, request expiry, permissions, grouped setup actions, private dashboard controls, active and finished thread organization, reopening, command deployment routes, online backup/restore integrity, payment validation, fixed listing prices and quantities, transcript generation, and duplicate-delivery prevention. The check command verifies JavaScript syntax, JSON, and the absence of Arabic text in built-in source strings.

`commands:validate` serializes and validates command definitions without credentials or HTTP. Only `commands:deploy` registers them. `db:init` applies idempotent migrations. For native SQLite build tools on Linux, install Python, Make, and a C++ compiler if your Node version has no prebuilt module.

Cloud tasks already have an isolated checkout. Use the existing checkout; do not create another Git worktree for normal development. Prepared dependencies persist in a cloud snapshot, but a bot process must be started again with runtime configuration. Live Discord login, command registration, and transcript delivery require validation in your server; offline tests alone do not establish those live permissions.
