const { ChannelType, PermissionFlagsBits } = require('discord.js');
const cleanupRepository = require('../database/threadOrganizationRepository');
const { getEscrowById } = require('../database/escrowRepository');
const { getThreadCleanupMinutes } = require('../database/guildSettingsRepository');
const { closeDealThread } = require('../utils/threadClosure');
const { processingDeals } = require('../utils/dealLocks');

const TERMINAL = new Set(['completed', 'cancelled', 'refunded']);
const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads];
const FRESH = { force: true, cache: false };

function codedError(code) { return Object.assign(new Error(code), { code }); }
function validTime(value) { return Number.isSafeInteger(value) && value > 0; }
function updatedTimestamp(value) {
    const text = String(value || '');
    const timestamp = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z` : text);
    return validTime(timestamp) ? timestamp : null;
}

function scopedThread(thread, escrow) {
    return thread?.id === escrow.channel_id && thread.guildId === escrow.guild_id &&
        thread.type === ChannelType.PrivateThread && typeof thread.parentId === 'string' &&
        Boolean(thread.parentId);
}

async function latestActivity(thread, escrow) {
    const updatedAt = updatedTimestamp(escrow.updated_at);
    // A malformed legacy timestamp must not make a conversation look idle.
    if (!updatedAt) throw codedError('InvalidDealTimestamp');
    const messages = await thread.messages.fetch({ limit: 1, cache: false });
    const latest = messages.first?.() ?? messages.values?.().next().value;
    if (latest && !validTime(latest.createdTimestamp)) throw codedError('InvalidMessageTimestamp');
    return Math.max(updatedAt, thread.archived === false && validTime(thread.archiveTimestamp)
        ? thread.archiveTimestamp : 0, latest?.createdTimestamp || 0);
}

/** A bounded, lease-backed pass. Importing the module performs no Discord work. */
async function processThreadOrganization(client, {
    limit = 5,
    repository = cleanupRepository,
    findEscrow = getEscrowById,
    getPolicy = getThreadCleanupMinutes,
    closeThread = closeDealThread,
    locks = processingDeals,
    clock = Date.now,
    shouldStop = () => Boolean(client?.dealBotStopping),
    onError = error => console.warn('[THREADS] Finished-chat cleanup failed:', error.code ?? error.name),
} = {}) {
    const stats = { claimed: 0, archived: 0, deferred: 0, unavailable: 0, failed: 0 };
    if (shouldStop()) return stats;
    if (!client?.user?.id || client.user.bot !== true) throw codedError('MissingBotIdentity');
    repository.seedThreadCleanupJobs({ now: clock() });
    const jobs = repository.claimThreadCleanupJobs({ limit, now: clock() });
    stats.claimed = jobs.length;
    for (const job of jobs) {
        const key = String(job.escrow_id);
        const defer = dueAt => {
            if (repository.deferThreadCleanup(job, { dueAt, now: clock() })) stats.deferred++;
        };
        if (shouldStop() || locks.has(key)) {
            defer(clock() + 60_000);
            continue;
        }
        locks.add(key);
        try {
            let escrow = findEscrow(job.escrow_id);
            const eligible = () => {
                escrow = findEscrow(job.escrow_id);
                return !shouldStop() && escrow && TERMINAL.has(escrow.status) &&
                    escrow.channel_id === job.escrow?.channel_id && escrow.guild_id === job.escrow?.guild_id &&
                    getPolicy(escrow.guild_id) > 0 && repository.ownsThreadCleanup(job, { now: clock() });
            };
            if (!eligible()) { defer(clock() + 60_000); continue; }
            const guild = await client.guilds.fetch(escrow.guild_id);
            if (!guild || guild.id !== escrow.guild_id) throw codedError('GuildScopeMismatch');
            let thread;
            try { thread = await guild.channels.fetch(escrow.channel_id, FRESH); }
            catch (error) {
                if (Number(error.code) !== 10003) throw error;
                if (repository.finishThreadCleanup(job, { status: 'unavailable', now: clock() })) stats.unavailable++;
                continue;
            }
            if (!scopedThread(thread, escrow)) throw codedError('ThreadScopeMismatch');
            // Historical archives stay historical: do not generate a new transcript
            // or DM simply because cleanup was enabled or the process restarted.
            if (thread.archived === true) {
                if (!validTime(thread.archiveTimestamp)) throw codedError('MissingArchiveTimestamp');
                repository.finishThreadCleanup(job, { archiveTimestamp: thread.archiveTimestamp, now: clock() });
                continue;
            }
            const [botMember, parent] = await Promise.all([
                guild.members.fetchMe({ force: true }), guild.channels.fetch(thread.parentId, FRESH),
            ]);
            if (!botMember || botMember.guild?.id !== escrow.guild_id || !parent ||
                parent.id !== thread.parentId || parent.guildId !== escrow.guild_id || parent.type !== ChannelType.GuildText) {
                throw codedError('ThreadParentScopeMismatch');
            }
            if (!parent.permissionsFor(botMember)?.has(REQUIRED_PERMISSIONS) ||
                !thread.permissionsFor(botMember)?.has(REQUIRED_PERMISSIONS)) throw codedError('MissingThreadPermissions');
            let deferredUntil = null;
            let observedArchive = null;
            const beforeArchive = async () => {
                if (!eligible()) return false;
                const [fresh, freshParent, freshBot] = await Promise.all([
                    guild.channels.fetch(escrow.channel_id, FRESH),
                    guild.channels.fetch(parent.id, FRESH), guild.members.fetchMe({ force: true }),
                ]);
                if (!scopedThread(fresh, escrow) || fresh.parentId !== parent.id) throw codedError('ThreadScopeMismatch');
                if (!freshParent || freshParent.id !== parent.id || freshParent.guildId !== escrow.guild_id ||
                    freshParent.type !== ChannelType.GuildText || freshBot?.guild?.id !== escrow.guild_id) {
                    throw codedError('ThreadParentScopeMismatch');
                }
                if (fresh.archived === true) {
                    observedArchive = fresh.archiveTimestamp;
                    return false;
                }
                if (!freshParent.permissionsFor(freshBot)?.has(REQUIRED_PERMISSIONS) ||
                    !fresh.permissionsFor(freshBot)?.has(REQUIRED_PERMISSIONS)) throw codedError('MissingThreadPermissions');
                const lastActivity = await latestActivity(fresh, escrow);
                // Recheck state and lease after awaiting message history. A policy
                // change invalidates the claim, including a change to "Off".
                if (!eligible()) return false;
                const currentUpdatedAt = updatedTimestamp(escrow.updated_at);
                if (!currentUpdatedAt) throw codedError('InvalidDealTimestamp');
                const dueAt = Math.max(lastActivity, currentUpdatedAt) + getPolicy(escrow.guild_id) * 60_000;
                if (dueAt > clock()) { deferredUntil = dueAt; return false; }
                return true;
            };
            const result = await closeThread({ channel: thread, escrowId: escrow.id,
                actor: { id: client.user.id, username: 'DealBot (automatic cleanup)', bot: true },
                kind: 'automatic', reason: 'Finished deal conversation archived after inactivity', beforeArchive });
            if (result.archived) {
                const timestamp = result.archiveTimestamp;
                if (!validTime(timestamp)) throw codedError('MissingArchiveTimestamp');
                if (repository.finishThreadCleanup(job, { archiveTimestamp: timestamp, automatic: !result.alreadyArchived,
                    actorId: client.user.id, now: clock() })) stats.archived++;
            } else if (validTime(observedArchive)) {
                repository.finishThreadCleanup(job, { archiveTimestamp: observedArchive, now: clock() });
            } else { defer(Math.max(clock() + 60_000, deferredUntil || 0)); }
        } catch (error) {
            if (repository.failThreadCleanup(job, { errorCode: error, now: clock() })) stats.failed++;
            onError(error);
        } finally { locks.delete(key); }
    }
    return stats;
}

/** Starts after login only, runs serially, and drains its active pass on stop. */
function startThreadOrganization({ client, intervalMs = 60_000,
    processQueue = processThreadOrganization, schedule = setInterval, cancel = clearInterval,
    onError = error => console.warn('[THREADS] Organization maintenance failed:', error.code ?? error.name),
} = {}) {
    if (!client || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || typeof processQueue !== 'function') {
        throw new Error('A client, cleanup worker, and positive organization interval are required.');
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

module.exports = { processThreadOrganization, startThreadOrganization };
