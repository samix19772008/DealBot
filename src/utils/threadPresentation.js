/** Stable, short names keep several simultaneous deals easy to distinguish. */
function dealThreadName(escrow) {
    const id = String(escrow.id).padStart(4, '0');
    const firstLine = String(escrow.item_description || '').split(/\r?\n/).find(line => line.trim()) || 'item';
    const item = firstLine.replace(/<a?:[^:>]+:\d+>/g, ' ').replace(/<[@#][^>]+>/g, ' ')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
    const prefix = `deal-${id}-`;
    return `${prefix}${item.slice(0, Math.max(1, 100 - prefix.length)).replace(/-+$/g, '')}`;
}

module.exports = { dealThreadName };
