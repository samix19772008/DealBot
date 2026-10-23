const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let checked = 0;
let failed = false;
function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', '.git', 'data', 'coverage'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) inspect(file);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
            const content = fs.readFileSync(file, 'utf8');
            if (/[\u0600-\u06ff]/u.test(content)) {
                console.error(`Non-English Arabic text found in ${path.relative(root, file)}`);
                failed = true;
            }
            if (entry.name.endsWith('.js')) {
                const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
                if (result.status !== 0) {
                    console.error(result.stderr || result.error?.message || `Syntax check failed: ${file}`);
                    failed = true;
                }
                checked++;
            } else {
                try { JSON.parse(content); }
                catch { console.error(`Invalid JSON: ${file}`); failed = true; }
            }
        }
    }
}
inspect(root);
console.log(`Checked ${checked} JavaScript files, JSON validity, and English source text.`);
process.exitCode = failed ? 1 : 0;
