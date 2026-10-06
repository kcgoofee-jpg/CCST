import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { shQuote } from '../launcher/core.mjs';
import { shQuote as proxyShQuote } from '../src/proxy/platform/launcher.js';

// zsh lives at /bin/zsh on macOS but not necessarily on Linux CI runners.
const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh', 'zsh'].find(existsSync) ?? null;

// Both build a zsh command line around a path (or a notification text) they do
// not control: a double-quoted JSON string still expands `$…` and backticks.
test('shQuote keeps shell metacharacters in a path literal', () => {
    assert.equal(shQuote("/tmp/lib.zsh"), "'/tmp/lib.zsh'");
    assert.equal(shQuote("$HOME/it's/lib.zsh"), "'$HOME/it'\\''s/lib.zsh'");
    assert.equal(proxyShQuote('`id`'), "'`id`'");
});

test('zsh sees exactly the quoted value back', { skip: process.platform === 'win32' || !ZSH }, () => {
    for (const value of ['/a b/lib.zsh', "$HOME/it's `echo hacked`", 'a$(echo hacked)b']) {
        const r = spawnSync(ZSH, ['-c', `printf '%s' ${shQuote(value)}`], { encoding: 'utf8' });
        assert.equal(r.stdout, value);
    }
});
