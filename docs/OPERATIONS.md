# Operate DealBot before a public announcement

Prepare and test the bot in a private Discord server. Public users are not needed to verify installation, permissions, deal steps, restarts, transcript retries, and backup recovery. Keep one bot process and one SQLite writer installation for the application. Choose **Docker Compose or systemd** below; do not start both against the same bot token and data.

These files prepare deployment. They do not buy hosting, create a server, change the Discord application, upload backups, or establish an alerting service. The operator must supply a Linux host that remains online, its access credentials, the bot credentials, and a destination for recovery copies away from that host.

## Prepare a private rehearsal

1. Keep the existing `.env` and database, including WAL/SHM sidecars if present. Take a verified backup before upgrading. A release download contains source, not the live token or database.
2. Use a private Discord server with separate buyer, seller, and moderator accounts. Configure the hub and moderator role, then run `/setup` until the required checks pass.
3. Refresh command definitions with `npm run commands:deploy` from a checkout with the intended `.env`. This is the step that contacts Discord to register commands; offline validation does not register them.
4. Start the new version using one deployment method. Review its logs and health result before making a request.
5. Run the private acceptance sequence below, including a restart and backup restoration. Record the release, results, and any unresolved errors before announcing availability.

## Conversation organization

Version 1.7 adds `/set-thread-policy` and updates `/deals`; refresh guild or global command definitions as appropriate for the installation. Startup adds the cleanup queue and per-server policy without deleting existing records. New servers and upgraded servers default to **30 minutes** of inactivity before finished conversations are locked and archived. Administrators can choose 15, 30, 60, or 1,440 minutes, or Off. Use `/set-thread-policy archive-after` in each server to change it.

Only `completed`, `cancelled`, and `refunded` deals with a conversation are eligible. The worker checks roughly once per minute in batches of five and defers a thread when recent messages or a reopening restart its idle interval. It also tidies existing finished, unarchived threads. Already archived historical conversations are marked processed without recapturing or resending their transcripts. Queued cleanup and retries persist in SQLite. No conversation, deal record, or captured file is deleted by this policy.

Pending, accepted, paid, delivered, and disputed deals are excluded from finished-thread cleanup. New deal threads still use Discord's separate 24-hour inactivity auto-archive setting; archiving does not change their deal state. A participant can select an accepted active deal in the private `/deals` dashboard and use **Resume Conversation**, subject to current server access, thread permissions, and private-thread membership. Removed members are not added automatically. Ordinary participants cannot unlock a locked thread; authorized local staff must also have current Manage Threads permission. Finished conversations remain archived.

Several trades remain separate private threads under one hub; a shared thread would mix participants and evidence. New names such as `deal-0042-menace-cape` keep them short. `/deals` provides six entries per page, Active/Needs your action/Completed/All filters, navigation, and full details on selection. Its controls are bound to the requesting user and server. Plan moderation access and Discord thread capacity even with cleanup enabled.

## Docker Compose

Docker Engine and its Compose plugin must already be installed on the host. The image uses Node.js 24 LTS, builds the native SQLite dependency in a separate build stage, and runs as UID/GID `1000:1000`. It exposes no listening port. Docker pulls the Node base image and npm downloads the locked dependencies during the build.

From the release folder:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally with the real Discord token, application ID, and private server ID. Do not commit it or paste its contents into logs. If it already exists, keep it rather than running the copy command again. The optional `DEALBOT_ENV_FILE` environment variable can select another protected environment-file path.

Validate the deployment without printing its expanded secrets, build it, and start one bot:

```sh
docker compose config --quiet
docker compose build
docker compose up -d bot
docker compose ps
docker compose logs --tail=100 bot
```

If the build runs behind an organization-controlled proxy, Docker supports the standard `http_proxy`/`https_proxy` build arguments. An additional trusted CA can be supplied as the optional BuildKit secret `build_ca`; it is available only during dependency installation and is not copied into the runtime image. Keep normal certificate verification enabled. A host whose container network cannot resolve its configured proxy must have that network configuration fixed before deployment.

The `dealbot-data` named volume contains `/app/data/escrow.sqlite`, SQLite sidecars, and verified snapshots under `/app/data/backups/`. Docker initializes a new volume from the image's private, UID-1000-owned directory. If substituting a bind mount or an existing volume, make its directory writable by UID 1000 and keep it private; do not use `chmod 777`.

The root filesystem is read-only. Temporary health files use a tmpfs, capabilities are dropped, and the process cannot acquire additional privileges. Log rotation bounds Docker logs. The included 1 GiB/one-CPU limits are a starting configuration to measure during private tests, not a capacity guarantee for a large marketplace.

### Move an existing database into Docker

Stop the old process first. Preserve its original files. Create a verified standalone snapshot using `npm run db:backup`, then initialize the named volume and copy **that snapshot** into it. Do not copy a running WAL database as a lone `.sqlite` file.

For a **new empty volume**, import the verified snapshot through the container's non-root account. This keeps UID 1000 ownership, streams the copy, and refuses to overwrite an existing database:

```sh
docker compose run --rm --no-deps -i -T bot node -e 'const fs = require("node:fs"); const output = fs.createWriteStream(process.env.DATABASE_PATH, { flags: "wx", mode: 0o600 }); output.on("error", error => { console.error(error.code); process.exitCode = 1; process.stdin.destroy(); }); process.stdin.pipe(output);' < /absolute/path/to/verified-backup.sqlite
docker compose run --rm --no-deps bot node scripts/init-db.js
docker compose up -d bot
```

Continue only if the import exits successfully. For an existing volume, preserve its current database and sidecars first and use a separate recovery volume for rehearsal; do not overwrite the only live copy. Remove stale sidecars only after the old process is stopped and those files have been preserved. Ordinary container replacement does not require importing the database again.

### Docker health and backups

```sh
docker compose exec -T bot node scripts/healthcheck.js
docker compose exec -T bot node scripts/backup-database.js
```

The health command checks a recent heartbeat and its last known Discord-ready state. It is not a test trade or a guarantee of Discord availability. Docker marks failed health checks as unhealthy; the restart policy restarts an exited process, but does not itself restart a process merely because its health status is unhealthy. Arrange monitoring of that status on the host and investigate repeated failures.

`BACKUP_INTERVAL_HOURS=24` in Compose enables a verified local backup after startup and once every 24 hours while the bot runs. Backup errors are logged. Snapshots use unique filenames; no automatic deletion is configured. Watch disk space and arrange a retention policy and regular transfer to storage away from the host. A copy on the same disk does not protect against losing that disk.

Copy a selected completed snapshot out of the container, then verify it on the host or in a separate container with the matching release:

```sh
docker compose cp bot:/app/data/backups/CHOSEN-BACKUP.sqlite ./recovery-copy.sqlite
npm run db:verify-backup -- ./recovery-copy.sqlite
```

On a Docker-only host without Node installed, verify the selected in-volume snapshot with `docker compose exec -T bot node scripts/verify-backup.js /app/data/backups/CHOSEN-BACKUP.sqlite`, then copy that completed file to protected off-host storage.

Replace `CHOSEN-BACKUP.sqlite` with the exact filename reported by the backup command. Use the named snapshot rather than copying a file while it is still being written. Store the verified copy in the operator's protected off-host destination; no destination or transfer credentials are configured by this repository.

Stop with `docker compose stop bot`. For upgrades, take a backup, stop the bot, replace source, build, and run `docker compose up -d bot`. The named volume persists through container replacement. **Do not use `docker compose down -v` for an upgrade**, because that deletes the named data volume.

## systemd alternative

Use this alternative on a Linux host with systemd and a system-wide Node.js 24 LTS installation. The supplied units expect `/usr/bin/node`. Check the actual executable with `command -v node` and change both service `ExecStart` paths if needed. A Node installation inside a personal home directory is incompatible with the service's `ProtectHome=true` setting.

Build dependencies on the target operating system with `npm ci`, run the offline checks, then install the reviewed source and its `node_modules` under `/opt/dealbot`. Keep that code root-owned and readable by the `dealbot` account; only the state and runtime directories should be writable by the service account. Credentials belong in `/etc/dealbot/dealbot.env`, not the public source folder.

Create the service account and credential directory if they do not already exist:

```sh
sudo useradd --system --user-group --home-dir /var/lib/dealbot --shell /usr/sbin/nologin dealbot
sudo install -d -m 0755 -o root -g root /etc/dealbot /opt/dealbot
sudo install -m 0600 -o root -g root .env /etc/dealbot/dealbot.env
sudo cp deploy/systemd/dealbot.service /etc/systemd/system/
sudo cp deploy/systemd/dealbot-backup.service /etc/systemd/system/
sudo cp deploy/systemd/dealbot-backup.timer /etc/systemd/system/
```

Skip `useradd` if the account already exists. Install the reviewed application files into `/opt/dealbot` before starting the unit. If migrating data, stop the old bot and install the verified backup at `/var/lib/dealbot/escrow.sqlite`, owned by `dealbot:dealbot` with mode `0600`; preserve old data first. The state directory itself should have mode `0700`.

The main service sets `DATABASE_PATH=/var/lib/dealbot/escrow.sqlite`, `HEALTH_STATUS_PATH=/run/dealbot/health.json`, and `BACKUP_INTERVAL_HOURS=24`. systemd creates private state/runtime directories and supervises process exits. It permits writes only to those directories and private temporary storage. The environment file is read by systemd; do not `source` an unreviewed file as shell code.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dealbot.service
sudo systemctl status dealbot.service
sudo journalctl -u dealbot.service -n 100 --no-pager
sudo -u dealbot env HEALTH_STATUS_PATH=/run/dealbot/health.json /usr/bin/node /opt/dealbot/scripts/healthcheck.js
```

Register Discord commands once from the operator's configured checkout using `npm run commands:deploy` after upgrading definitions. The runtime service does not automatically change registered commands.

### Optional systemd backup timer

The main service's built-in scheduler already runs daily. Use the supplied backup timer **instead** only if backups should be managed by systemd independently of the bot process. First set `BACKUP_INTERVAL_HOURS=0` in a service override; then enable the timer. Do not enable both schedules by accident.

```ini
[Service]
Environment=BACKUP_INTERVAL_HOURS=0
```

After creating that override through `sudo systemctl edit dealbot.service`:

```sh
sudo systemctl daemon-reload
sudo systemctl restart dealbot.service
sudo systemctl start dealbot-backup.service
sudo systemctl enable --now dealbot-backup.timer
sudo systemctl list-timers dealbot-backup.timer
```

The timer is scheduled at 04:00 UTC, with up to 15 minutes of random delay, and catches up after host downtime. The backup service does not load the Discord token or contact Discord. Its first run requires an initialized database. Verify its result with `journalctl -u dealbot-backup.service`, then copy selected completed snapshots away from the host. Neither the service nor timer deletes old backups.

## Private acceptance sequence

Use test listings and test deal confirmations with the buyer, seller, and moderator accounts. Keep the server private until the operator has reviewed the results.

| Check | Expected result |
| --- | --- |
| `/setup` in the intended server | All required hub and staff checks pass; optional rank mappings are clear |
| `Preview Listing` on both decorated example styles | Separate ranks, prices, variants, and packs match the source; stock-zero offers are unavailable |
| Buy one pack and two packs | Only that product's payment methods appear; quantity multiplies the chosen pack's price |
| Edit or delete a post after opening its picker | Old picker cannot create a request from obsolete terms |
| Normal completion | Buyer payment, seller delivery, buyer receipt, and local reputation advance once |
| Several simultaneous trades | Separate compact private threads appear under one hub, each with only its intended participants and authorized staff |
| Dashboard privacy and navigation | Six entries per page, filters, paging, refresh, and selection show the user's own deals; another user or server cannot reuse the controls |
| Open and resolve a dispute | Confirmation steps pause; only authorized staff resolve it; the decision is recorded |
| Close a completed deal | The intended participants receive the recorded conversation; closer and time are correct |
| Finished-thread cleanup | A finished idle thread is locked and archived after its policy interval and worker tick; the record names DealBot (automatic cleanup), and evidence is retained |
| New messages, exclusions, and policy Off | Recent activity defers cleanup; active/disputed deals are excluded; disabling the policy leaves human closure available |
| Resume an active conversation | Current authorized members can resume an archived accepted active thread; removed members and unrelated users cannot, staff locks are respected, and terminal threads stay archived |
| One participant blocks DMs | The other can still receive their transcript; failed delivery is retained for retry under the documented queue policy |
| Private transcript recovery | A participant or authorized local moderator can use `/transcript` in the original server to retrieve an available saved conversation file |
| Restart while delivery is pending | Saved work survives restart and already-confirmed deliveries are not deliberately sent again |
| Restart while cleanup is pending | Saved cleanup resumes and the historical-archive scan does not resend old transcripts |
| Restart the process or reboot the host | The same database remains, the supervisor starts the bot, and health becomes ready after Discord connects |
| Deliberately remove a required hub permission | A useful private error appears; no partial accepted deal is left behind |
| Backup and recovery | A completed snapshot passes `db:verify-backup`; a separate restored installation preserves expected test records |

Also test the operating limits you actually expect: several simultaneous requests, a long conversation, and the largest normal market post. Measure memory, disk growth, response time, and queue backlog. Local tests and a restart policy do not establish capacity for every server size.

## Recovery rehearsal

Never test restoration by overwriting the only live database. Copy a completed snapshot to a **new** path and run `npm run db:verify-backup -- /path/to/copy.sqlite`. This rehearses migration in a temporary copy without logging into Discord. Keep production-snapshot verification offline: connecting a copied production queue can resume real pending notifications.

For a live private rehearsal, use a snapshot containing only disposable private-test deals. Stop the original test bot, preserve its current database and sidecars, then start the restored copy in the private test installation. Docker operators can use a separate project name, such as `docker compose --project-name dealbot-recovery`, to give the rehearsal a separate named volume. Keep only one running process for each bot token. Check deals, settings, reputation, and queued delivery state before deciding to use a snapshot for actual recovery.

If a transcript send reached Discord immediately before the process crashed but the delivery acknowledgement was not saved, its final outcome may be uncertain. Review the delivery policy and observed logs; do not promise mathematically exact-once delivery across that boundary.

Before public availability, provide a real support contact, decide who can review disputes and access records, and state the record-retention policy. Hosting, off-host copies, monitoring notifications, Discord application approval requirements, and the private acceptance results must be completed for the actual installation; source files alone do not activate them.
