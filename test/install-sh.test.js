import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(fileURLToPath(import.meta.url), '..', '..', 'deploy', 'install.sh');
const skip = process.platform === 'win32' ? 'POSIX sh only' : false;

function run(args, home) {
    return spawnSync('sh', [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

test('install.sh --dry-run prints the plan and touches nothing', { skip }, () => {
    const home = mkdtempSync(join(tmpdir(), 'ccst-inst-'));
    try {
        const r = run(['--dry-run', '--port', '18999', '--public'], home);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[dry-run\] git clone/);
        assert.match(r.stdout, /监听 0\.0\.0\.0/);
        assert.match(r.stdout, /!!! 已监听 0\.0\.0\.0/);
        assert.match(r.stdout, /npm run login/);
        assert.deepEqual(readdirSync(home), []);
        assert.equal(existsSync(join(home, '.config')), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install.sh default binds 127.0.0.1 with no public warning', { skip }, () => {
    const home = mkdtempSync(join(tmpdir(), 'ccst-inst-'));
    try {
        const r = run(['--dry-run'], home);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /监听 127\.0\.0\.1/);
        assert.doesNotMatch(r.stdout, /!!! 已监听/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install.sh rejects bad options', { skip }, () => {
    const home = mkdtempSync(join(tmpdir(), 'ccst-inst-'));
    try {
        assert.notEqual(run(['--port', 'abc'], home).status, 0);
        assert.notEqual(run(['--nope'], home).status, 0);
        assert.notEqual(run(['--dir', '/a b/c', '--dry-run'], home).status, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install.sh --uninstall --dry-run on a clean home is harmless', { skip }, () => {
    const home = mkdtempSync(join(tmpdir(), 'ccst-inst-'));
    try {
        const r = run(['--uninstall', '--dry-run'], home);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(readdirSync(home), []);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// bash 3.2 (macOS /bin/sh) folds the bytes of a following fullwidth 「，」 or
// 「（」 into the variable name, so `$DIR，` is an unbound variable and the
// script dies under `set -u`. Every $NAME must end at an ASCII character.
test('install.sh braces every variable that a fullwidth punctuation follows', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const bad = [...src.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], `$NAME followed by a multibyte character: ${bad.join(' ')}`);
});
