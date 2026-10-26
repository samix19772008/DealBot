const { ChannelType, PermissionFlagsBits } = require('discord.js');
const activeRepository = require('../database/activeThreadOrganizationRepository');
const { getEscrowById } = require('../database/escrowRepository');
const { getActiveThreadIdleMinutes } = require('../database/guildSettingsRepository');
const { processingDeals } = require('../utils/dealLocks');

const ACTIVE = new Set(['awaiting_payment', 'funded', 'delivered']);
const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads];
const FRESH = { force: true, cache: false };

function failure(code) { return Object.assign(new Error(code), { code }); }
function validTime(value) { return Number.isSafeInteger(value) && value > 0; }
function updatedTimestamp(value) {
    const text = String(value || '');
    const time = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z` : text);
    if (!validTime(time)) throw failure('InvalidDealTimestamp');
    return time;
}

function scopedThread(thread, escrow) {
    return thread?.id === escrow.channel_id && thread.guildId === escrow.guild_id &&
        thread.type === ChannelType.PrivateThread && typeof thread.parentId === 'string' && Boolean(thread.parentId);
}

/** Hide idle conversations without completing, locking, or exporting a deal. */
async function processActiveThreadOrganization(client, {
    limit = 5,
    repository = activeRepository,
    findEscrow = getEscrowById,
    getPolicy = getActiveThreadIdleMinutes,
    locks = processingDeals,
    clock = Date.now,
    shouldStop = () => Boolean(client?.dealBotStopping),
    onError = error => console.warn('[THREADS] Idle conversation organization failed:', error.code ?? error.name),
} = {}) {
    const stats = { claimed: 0, hidden: 0, deferred: 0, unavailable: 0, failed: 0 };
    if (shouldStop()) return stats;
    if (!client?.user?.id || client.user.bot !== true) throw failure('MissingBotIdentity');
    repository.seedActiveThreadCleanupJobs({ now: clock() });
    const jobs = repository.claimActiveThreadCleanupJobs({ limit, now: clock() });
    stats.claimed = jobs.length;
    for (const job of jobs) {
        const key = String(job.escrow_id);
        const defer = dueAt => {
            if (repository.deferActiveThreadCleanup(job, { dueAt, now: clock() })) stats.deferred++;
        };
        if (shouldStop() || locks.has(key)) { defer(clock() + 60_000); continue; }
        locks.add(key);
        try {
            let escrow;
            const eligible = () => {
                escrow = findEscrow(job.escrow_id);
                return !shouldStop() && escrow && ACTIVE.has(escrow.status) &&
                    escrow.guild_id === job.escrow?.guild_id && escrow.channel_id === job.escrow?.channel_id &&
                    getPolicy(escrow.guild_id) > 0 && repository.ownsActiveThreadCleanup(job, { now: clock() });
            };
            if (!eligible()) { defer(clock() + 60_000); continue; }
            const guild = await client.guilds.fetch(escrow.guild_id);
            if (!guild || guild.id !== escrow.guild_id) throw failure('GuildScopeMismatch');
            let thread;
            try { thread = await guild.channels.fetch(escrow.channel_id, FRESH); }
            catch (error) {
                if (Number(error.code) !== 10003) throw error;
                if (repository.finishActiveThreadCleanup(job, { status: 'unavailable', now: clock() })) stats.unavailable++;
                continue;
            }
            if (!scopedThread(thread, escrow)) throw failure('ThreadScopeMismatch');
            if (thread.archived === true) {
                if (!validTime(thread.archiveTimestamp)) throw failure('MissingArchiveTimestamp');
                repository.finishActiveThreadCleanup(job, { archiveTimestamp: thread.archiveTimestamp, now: clock() });
                continue;
            }
            const parentId = thread.parentId;
            // Resolve current channel, parent, bot permissions, and history together
            // again before mutation; the original cached object is never authority.
            const inspect = async () => {
                if (!eligible()) return { changed: true };
                const [fresh, parent, botMember] = await Promise.all([
                    guild.channels.fetch(escrow.channel_id, FRESH),
                    guild.channels.fetch(parentId, FRESH), guild.members.fetchMe({ force: true }),
                ]);
                if (!scopedThread(fresh, escrow) || fresh.parentId !== parentId ||
                    !parent || parent.id !== parentId || parent.guildId !== escrow.guild_id ||
                    parent.type !== ChannelType.GuildText || botMember?.guild?.id !== escrow.guild_id) {
                    throw failure('ThreadScopeMismatch');
                }
                if (!parent.permissionsFor(botMember)?.has(REQUIRED_PERMISSIONS) ||
                    !fresh.permissionsFor(botMember)?.has(REQUIRED_PERMISSIONS)) throw failure('MissingThreadPermissions');
                if (fresh.archived === true) return { archived: fresh };
                // A staff lock is an explicit moderation decision. Never unlock it
                // or hide that live conversation as part of ordinary idle cleanup.
                if (fresh.locked !== false) return { locked: true };
                return { thread: fresh };
            };
            let inspected = await inspect();
            if (inspected.changed) { defer(clock() + 60_000); continue; }
            if (inspected.archived) {
                if (!validTime(inspected.archived.archiveTimestamp)) throw failure('MissingArchiveTimestamp');
                repository.finishActiveThreadCleanup(job, { archiveTimestamp: inspected.archived.archiveTimestamp, now: clock() });
                continue;
            }
            if (inspected.locked) { defer(clock() + 15 * 60_000); continue; }
            thread = inspected.thread;
            const messages = await thread.messages.fetch({ limit: 1, cache: false });
            const message = messages.first?.() ?? messages.values?.().next().value;
            if (message && !validTime(message.createdTimestamp)) throw failure('InvalidMessageTimestamp');
            const newestMessage = message?.createdTimestamp || 0;
            // Status, permissions, and staff locks may change while history loads.
            inspected = await inspect();
            if (inspected.changed) { defer(clock() + 60_000); continue; }
            if (inspected.archived) {
                if (!validTime(inspected.archived.archiveTimestamp)) throw failure('MissingArchiveTimestamp');
                repository.finishActiveThreadCleanup(job, { archiveTimestamp: inspected.archived.archiveTimestamp, now: clock() });
                continue;
            }
            if (inspected.locked) { defer(clock() + 15 * 60_000); continue; }
            thread = inspected.thread;
            if (!eligible()) { defer(clock() + 60_000); continue; }
            if (typeof thread.lastMessageId === 'string' && typeof message?.id === 'string' &&
                thread.lastMessageId !== message.id) {
                // A new message appeared while fresh permissions were loading.
                // Revisit it next tick rather than treating old history as idle.
                defer(clock() + 60_000); continue;
            }
            const activity = Math.max(updatedTimestamp(escrow.updated_at), newestMessage,
                validTime(thread.archiveTimestamp) ? thread.archiveTimestamp : 0);
            const dueAt = activity + getPolicy(escrow.guild_id) * 60_000;
            if (dueAt > clock()) { defer(dueAt); continue; }
            let archived;
            try { archived = await thread.setArchived(true, 'Idle active deal conversation hidden; the deal remains active'); }
            catch (error) {
                // The HTTP response may be lost after a successful edit. A fresh
                // observation avoids repeating the archive or inventing success.
                const actual = await guild.channels.fetch(escrow.channel_id, FRESH).catch(() => null);
                if (!scopedThread(actual, escrow) || actual.archived !== true) throw error;
                archived = actual;
            }
            if (!scopedThread(archived, escrow) || archived.archived !== true || !validTime(archived.archiveTimestamp)) {
                throw failure('MissingArchiveTimestamp');
            }
            if (repository.finishActiveThreadCleanup(job, { archiveTimestamp: archived.archiveTimestamp,
                automatic: true, actorId: client.user.id, now: clock() })) stats.hidden++;
        } catch (error) {
            if (repository.failActiveThreadCleanup(job, { errorCode: error, now: clock() })) stats.failed++;
            onError(error);
        } finally { locks.delete(key); }
    }
    return stats;
}

/** Starts after login only, with one bounded pass at a time and a draining stop. */
function startActiveThreadOrganization({ client, intervalMs = 60_000,
    processQueue = processActiveThreadOrganization, schedule = setInterval, cancel = clearInterval,
    onError = error => console.warn('[THREADS] Idle conversation maintenance failed:', error.code ?? error.name),
} = {}) {
    if (!client || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || typeof processQueue !== 'function') {
        throw new Error('A client, idle worker, and positive organization interval are required.');
    }
    let stopped = false;
    let active = null;
    let stopTask = null;
    const run = () => {
        if (stopped || active) return active;
        active = Promise.resolve().then(() => processQueue(client, { shouldStop: () => stopped || Boolean(client.dealBotStopping) }))
            .catch(onError).finally(() => { active = null; });
        return active;
    };
    run();
    const timer = schedule(run, intervalMs);
    timer.unref?.();
    return () => {
        if (stopTask) return stopTask;
        stopped = true;
        cancel(timer);
        stopTask = Promise.resolve(active).then(() => undefined);
        return stopTask;
    };
}

module.exports = { processActiveThreadOrganization, startActiveThreadOrganization };
