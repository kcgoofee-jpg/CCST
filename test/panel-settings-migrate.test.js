import { test } from 'node:test';
import assert from 'node:assert/strict';

const ext = {};
globalThis.SillyTavern = { getContext: () => ({ extensionSettings: ext, saveSettingsDebounced() {} }) };
const { getSettings, MODULE, defaultSettings, REMOVED_KEYS } = await import('../src/panel/core/settings.js');

test('a fresh install gets the defaults: world info moving on, 1-hour cache', () => {
    delete ext[MODULE];
    const s = getSettings();
    assert.equal(s.loreTail, true);
    assert.equal(s.cacheTtl, '1h');
    assert.equal(s.freshInstall, true);
});

test('keys of removed settings are deleted on start-up; kept ones stay', () => {
    ext[MODULE] = { onboarded: true, freshInstall: false, loreTail: false, effort: 'high', identityMode: true, accessKey: 'x', debugDump: true, diagCapture: false, panelTab: 'chat', heuristicChecks: true };
    const s = getSettings();
    for (const k of REMOVED_KEYS) assert.equal(k in s, false, k);
    assert.equal(s.loreTail, false, 'the user\'s choice is kept');
    for (const k of Object.keys(s)) assert.ok(k in defaultSettings, `${k} is a current setting`);
});
