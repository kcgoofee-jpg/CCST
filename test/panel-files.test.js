import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).split('\\').join('/');

/** The list the server plugin copies into SillyTavern (src/proxy/plugin.js). */
function installedFiles() {
    const src = readFileSync(join(root, 'src/proxy/plugin.js'), 'utf8');
    const m = src.match(/^const UI_EXTENSION_FILES = \[(.*)\];$/m);
    assert.ok(m, 'UI_EXTENSION_FILES not found in src/proxy/plugin.js');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

test('the auto-installed extension carries every panel and shared file, and nothing that does not exist', () => {
    const listed = new Set(installedFiles());
    for (const f of listed) assert.ok(existsSync(join(root, f)), `${f} is listed but missing`);
    // src/shared also holds proxy-only helpers: only the ones core/libs.js loads travel with the panel.
    const libs = readFileSync(join(root, 'src/panel/core/libs.js'), 'utf8');
    const shared = [...libs.matchAll(/'([\w-]+\.js)'/g)].map((m) => `src/shared/${m[1]}`);
    assert.ok(shared.length >= 5);
    const needed = [...walk(join(root, 'src/panel')).map(rel), ...shared];
    const missing = needed.filter((f) => !listed.has(f));
    assert.deepEqual(missing, [], `not in UI_EXTENSION_FILES: ${missing.join(', ')}`);
});

test('the manifest points at listed files', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const listed = new Set(installedFiles());
    assert.ok(listed.has('manifest.json'));
    assert.ok(listed.has(manifest.js));
    assert.ok(listed.has(manifest.css));
});

test('every relative import inside the panel resolves to an existing file', () => {
    const bad = [];
    for (const file of walk(join(root, 'src/panel')).filter((f) => f.endsWith('.js'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?:from\s+|import\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
            if (!existsSync(resolve(dirname(file), m[1]))) bad.push(`${rel(file)} -> ${m[1]}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('every feature the bootstrap lists exists in features/', () => {
    const index = readFileSync(join(root, 'src/panel/index.js'), 'utf8');
    const block = index.match(/const FEATURES = \[([\s\S]*?)\n\];/)[1];
    const files = [...block.matchAll(/\['[^']+',\s*'([^']+)'\]/g)].map((m) => m[1]);
    assert.ok(files.length >= 8);
    for (const f of files) assert.ok(existsSync(join(root, `src/panel/features/${f}.js`)), `features/${f}.js`);
    const onDisk = readdirSync(join(root, 'src/panel/features')).map((f) => f.replace(/\.js$/, ''));
    assert.deepEqual(onDisk.filter((f) => !files.includes(f)), [], 'a feature file the bootstrap never loads');
});
