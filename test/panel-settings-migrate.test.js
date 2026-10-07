import { test } from 'node:test';
import assert from 'node:assert/strict';

const ext = {};
globalThis.SillyTavern = { getContext: () => ({ extensionSettings: ext, saveSettingsDebounced() {} }) };
const { getSettings, MODULE, defaultSettings } = await import('../src/panel/core/settings.js');

test('diagnostics capture: on for a fresh install', () => {
    delete ext[MODULE];
    const s = getSettings();
    assert.equal(s.diagCapture, true);
    assert.equal(s.diagCaptureDefaulted, true);
    assert.equal(defaultSettings.diagCapture, true);
});

test('settings saved before 5.3 (no flag): turned on once; a later choice is kept', () => {
    ext[MODULE] = { diagCapture: false, onboarded: true, freshInstall: false };
    assert.equal(getSettings().diagCapture, true);
    getSettings().diagCapture = false; // the user turns it off
    assert.equal(getSettings().diagCapture, false, 'not flipped back');
    assert.equal(getSettings().diagCaptureDefaulted, true);
});
