const fs = require('node:fs');
const path = require('node:path');
const { buildTranscriptSummary } = require('../src/utils/transcriptPresentation');

// An offline illustration built from the same embed fields as real DMs.
const summary = buildTranscriptSummary({
    escrow: {
        id: 42, transaction_uuid: 'ESC-EXAMPLE-42', guild_id: '200000000000000001',
        channel_id: '300000000000000001', item_description: 'Menace Cape',
        buyer_username: 'Buyer', buyer_discord_id: '100000000000000001',
        seller_username: 'Seller', seller_discord_id: '100000000000000002',
        amount: 20, currency: 'Redblocks', payment_unit: 'stacks', status: 'completed',
    },
    closure: {
        archive_timestamp: Date.UTC(2026, 9, 24, 14), actor_name: 'Moderator',
        actor_discord_id: '100000000000000003', kind: 'moderator',
    },
    guild: { name: 'Marketplace', iconURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
}).embeds[0].toJSON();

const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const pieces = [];
const text = (x, y, value, attributes = '') => pieces.push(`<text x="${x}" y="${y}" ${attributes}>${escape(value)}</text>`);
text(25, 32, 'ILLUSTRATIVE DISCORD DM', 'fill="#949ba4" font-size="11" letter-spacing="1.2"');
pieces.push('<rect x="14" y="48" width="472" height="704" rx="8" fill="#2b2d31"/>');
pieces.push('<path d="M18 48V752" stroke="#8b5cf6" stroke-width="4"/>');
pieces.push('<circle cx="45" cy="78" r="13" fill="#8b5cf6"/>');
text(39, 83, 'M', 'font-size="13" font-weight="700" fill="white"');
text(67, 83, summary.author.name, 'font-size="14" font-weight="600" fill="#f2f3f5"');
pieces.push('<rect x="398" y="65" width="64" height="64" rx="8" fill="#8b5cf6"/>');
text(417, 107, 'M', 'font-size="30" font-weight="700" fill="white"');
text(32, 118, summary.title, 'font-size="18" font-weight="700" fill="#f2f3f5"');
let y = 153;
for (const field of summary.fields) {
    text(32, y, field.name, 'font-size="13" font-weight="600" fill="#f2f3f5"');
    let value = field.value.replace(/^```\n|\n```$/g, '');
    const timestamp = value.match(/^<t:(\d+):F>$/);
    if (timestamp) value = new Date(Number(timestamp[1]) * 1000).toLocaleString('en-US', { timeZone: 'Asia/Amman', dateStyle: 'medium', timeStyle: 'short' });
    pieces.push(`<rect x="32" y="${y + 9}" width="434" height="32" rx="4" fill="#202225" stroke="#1e1f22"/>`);
    text(42, y + 30, value, 'font-family="monospace" font-size="12" fill="#dbdee1"');
    y += 73;
}
pieces.push('<rect x="32" y="673" width="112" height="32" rx="4" fill="#4e5058"/>');
text(51, 694, 'View Deal ↗', 'font-size="13" font-weight="600" fill="#f2f3f5"');
text(32, 733, `${summary.footer.text} • Oct 24, 2026, 5:00 PM`, 'font-size="11" fill="#949ba4"');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="770" viewBox="0 0 500 770" role="img" aria-labelledby="title"><title id="title">DealBot transcript summary preview</title><rect width="500" height="770" fill="#313338"/><g font-family="Arial, sans-serif">${pieces.join('')}</g></svg>\n`;
const target = path.join(__dirname, '..', 'docs', 'transcript-preview.svg');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, svg);
console.log(`Wrote offline transcript card illustration: ${target}`);
