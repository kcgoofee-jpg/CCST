import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp } from '../src/panel/core/connect-help.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('one card, no guessing: names the address and lists what to check', () => {
    const h = connectHelp({ endpoint: 'http://192.168.31.7:8901/v1/' });
    assert.equal(h.key, 'offline');
    assert.match(h.sub, /192\.168\.31\.7:8901\/v1$/);
    assert.equal(h.steps.length, 3);
    assert.ok(h.steps.some((s) => /删了/.test(s.text)), 'covers a removed proxy');
});

test('offers the two one-click installers, served from the extension folder', () => {
    const h = connectHelp();
    assert.deepEqual(h.downloads.map((d) => d.label), ['下载一键安装（Mac）', '下载一键安装（Windows）']);
    for (const d of h.downloads) {
        assert.ok(existsSync(fileURLToPath(d.href)), `${d.file} exists in installer/`);
        assert.match(d.href, /\/installer\//);
    }
    assert.equal(h.hint, '双击下载的文件，按提示做完后重启酒馆');
});
