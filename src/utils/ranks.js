const RANKS = [
    { key: 'bronze', label: 'Bronze', emoji: '🥉', minPoints: 0 },
    { key: 'silver', label: 'Silver', emoji: '🥈', minPoints: 20 },
    { key: 'gold', label: 'Gold', emoji: '🥇', minPoints: 50 },
    { key: 'platinum', label: 'Platinum', emoji: '💠', minPoints: 100 },
    { key: 'diamond', label: 'Diamond', emoji: '💎', minPoints: 200 },
];

/** Return the highest rank reached by the stored trust score. */
function getRankForScore(trustScore) {
    for (let i = RANKS.length - 1; i >= 0; i--) {
        if (trustScore >= RANKS[i].minPoints) return RANKS[i];
    }
    return RANKS[0];
}

function getRankByKey(key) {
    return RANKS.find(rank => rank.key === key);
}

module.exports = { RANKS, getRankForScore, getRankByKey };
