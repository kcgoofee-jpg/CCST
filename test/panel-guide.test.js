import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SOURCES, chosenSource, sourceLinked, shouldAutoOnboard, guideStep, KEY_STEPS, SUMMARY, showsCacheCard,
    startGuide, pickSource, finishGuide, backToChoose, gateConnection, proxyUnknown, glanceLinked,
} from '../src/panel/core/guide.js';

const none = { kind: 'other', connected: false, direct: false };
const ours = { kind: 'ours', connected: true, direct: false };
const claude = { kind: 'claude', connected: false, direct: true };
const orouter = { kind: 'openrouter', connected: false, direct: true };
const nano = { kind: 'nanogpt', connected: false, direct: true };

test('four sources, each with a one-line audience', () => {
    assert.deepEqual(SOURCES.map((s) => s.id), ['proxy', 'claude', 'openrouter', 'relay']);
    for (const s of SOURCES) assert.ok(s.who.length > 8 && !s.who.includes('\n'));
    for (const id of ['claude', 'openrouter', 'relay']) assert.ok(KEY_STEPS[id].length >= 3);
    for (const s of SOURCES) assert.ok(SUMMARY[s.id].works.length && SUMMARY[s.id].gaps.length);
});

test('a fresh install (not connected, never started) starts at step 1', () => {
    assert.equal(guideStep({ onboarded: false, guideSource: '' }, none), 1);
    assert.equal(shouldAutoOnboard({ onboarded: false, guideSource: '' }, none), false);
});

test('already connected and never started: no guide, marked done automatically', () => {
    for (const conn of [ours, claude, orouter, nano]) {
        assert.equal(guideStep({ onboarded: false, guideSource: '' }, conn), 0);
        assert.equal(shouldAutoOnboard({ onboarded: false, guideSource: '' }, conn), true);
    }
    assert.equal(shouldAutoOnboard({ onboarded: true, guideSource: '' }, ours), false);
});

test('onboarded: the guide never shows, whatever the connection', () => {
    for (const conn of [none, ours, claude]) assert.equal(guideStep({ onboarded: true, guideSource: '' }, conn), 0);
});

test('picking a source moves to 连接, and connecting that source moves to 完成', () => {
    const at = (id, conn) => guideStep({ onboarded: false, guideSource: id }, conn);
    assert.equal(at('proxy', none), 2);
    assert.equal(at('proxy', ours), 3);
    assert.equal(at('claude', none), 2);
    assert.equal(at('claude', claude), 3);
    assert.equal(at('openrouter', orouter), 3);
    assert.equal(at('relay', nano), 3);
});

test('someone who started the guide and connects is NOT auto-marked: they see 第 3 步', () => {
    assert.equal(shouldAutoOnboard({ onboarded: false, guideSource: 'claude' }, claude), false);
    assert.equal(guideStep({ onboarded: false, guideSource: 'claude' }, claude), 3);
});

test('connected to a different source than the one picked stays on 连接', () => {
    assert.equal(sourceLinked('proxy', claude), false);
    assert.equal(sourceLinked('claude', ours), false);
    assert.equal(sourceLinked('claude', orouter), false);
    assert.equal(sourceLinked('relay', claude), false);
    assert.equal(sourceLinked('relay', orouter), false);
    assert.equal(sourceLinked('relay', { kind: 'custom', connected: false, direct: true }), true);
});

test('re-running the guide while connected starts at step 1, then 3 once a source is picked', () => {
    assert.equal(guideStep(startGuide(), ours), 1);
    assert.equal(guideStep(pickSource('proxy'), ours), 3);
    assert.equal(guideStep(backToChoose(), ours), 1);
});

test('choose / unknown / empty mean no source picked', () => {
    for (const v of ['', 'choose', 'nope', null, undefined]) assert.equal(chosenSource(v), null);
    assert.equal(chosenSource('claude'), 'claude');
    assert.deepEqual(pickSource('bogus'), startGuide());
});

test('finishing marks onboarded and clears the picked source', () => {
    assert.deepEqual(finishGuide(), { onboarded: true, guideSource: '' });
    assert.equal(guideStep(finishGuide(), none), 0);
});

test('the cache card is for direct sources only', () => {
    assert.equal(showsCacheCard('proxy'), false);
    for (const id of ['claude', 'openrouter', 'relay']) assert.equal(showsCacheCard(id), true);
});

// ── 4.1.1: only a brand-new install sees the guide ──
const boot = (over = {}) => ({ onboarded: false, guideSource: '', settingsExisted: false, everConnected: false, ...over });

test('brand-new install (no settings when the panel booted), not connected: step 1', () => {
    assert.equal(guideStep(boot(), none), 1);
});

test('settings existed at boot (installed before): never the guide, proxy down or not', () => {
    for (const conn of [none, ours, claude]) assert.equal(guideStep(boot({ settingsExisted: true }), conn), 0);
});

test('once connected, a later disconnect shows no guide', () => {
    assert.equal(guideStep(boot({ everConnected: true }), none), 0);
    assert.equal(guideStep(boot({ everConnected: false }), none), 1);
});

test('restarting the guide (其他 → 重新引导) shows it for anyone, even after connecting before', () => {
    const s = boot({ settingsExisted: true, everConnected: true, guideSource: 'choose' });
    assert.equal(guideStep(s, none), 1);
    assert.equal(guideStep({ ...s, guideSource: 'proxy' }, none), 2);
    assert.equal(guideStep({ ...s, guideSource: 'proxy' }, ours), 3);
});

test('skipping or finishing ends it for good', () => {
    assert.equal(guideStep(boot({ ...finishGuide() }), none), 0);
    assert.equal(guideStep({ ...boot(), ...finishGuide() }, none), 0);
});

test('gateConnection: ST pointing at the proxy counts only once the proxy answered', () => {
    for (const phase of ['offline', 'denied', 'pending', 'idle']) assert.equal(gateConnection(ours, phase).connected, false);
    for (const phase of ['online', 'nologin']) assert.equal(gateConnection(ours, phase).connected, true);
    assert.equal(gateConnection(claude, 'offline'), claude); // direct sources pass through
});

test('fresh install whose ST already points at an offline proxy still gets the guide', () => {
    const fresh = boot();
    assert.equal(guideStep(fresh, gateConnection(ours, 'offline')), 1);
    assert.equal(shouldAutoOnboard(fresh, gateConnection(ours, 'offline')), false);
    assert.equal(guideStep(fresh, gateConnection(ours, 'online')), 0); // answered: already a working user
});

test('proxyUnknown: no status check has finished yet', () => {
    assert.equal(proxyUnknown('pending'), true);
    assert.equal(proxyUnknown('idle'), true);
    assert.equal(proxyUnknown('online'), false);
    assert.equal(proxyUnknown('offline'), false);
});

test('glanceLinked: the status bar says 未连接 for a proxy connection whose proxy is offline', () => {
    assert.equal(glanceLinked(ours, 'offline'), false);
    assert.equal(glanceLinked(ours, 'online'), true);
    assert.equal(glanceLinked(ours, 'pending'), true);
    assert.equal(glanceLinked(claude, 'offline'), true);
    assert.equal(glanceLinked(none, 'online'), false);
});
