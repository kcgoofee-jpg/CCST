import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    GUIDE_STEPS, DONE_STEP, guideFacts, shouldAutoOnboard, guideStep, pollsProxy,
    startGuide, finishGuide, proxyUnknown, glanceLinked,
} from '../src/panel/core/guide.js';

const none = { kind: 'other', connected: false };
const ours = { kind: 'ours', connected: true };
const facts = (conn, phase) => guideFacts(conn, phase);
const boot = (over = {}) => ({ onboarded: false, guideSource: '', settingsExisted: false, everConnected: false, ...over });

test('three steps, named 安装 / 登录 / 连接, then 完成', () => {
    assert.deepEqual(GUIDE_STEPS.map((s) => s.key), ['install', 'login', 'connect']);
    assert.deepEqual(GUIDE_STEPS.map((s) => s.title), ['安装', '登录', '连接']);
    assert.equal(DONE_STEP, 4);
});

test('facts: reachable / logged in / connected come only from the status phase and ST\'s connection', () => {
    assert.deepEqual(facts(none, 'offline'), { checking: false, reachable: false, loggedIn: false, connected: false });
    assert.deepEqual(facts(none, 'nologin'), { checking: false, reachable: true, loggedIn: false, connected: false });
    assert.deepEqual(facts(ours, 'online'), { checking: false, reachable: true, loggedIn: true, connected: true });
    assert.equal(facts(ours, 'offline').connected, false, 'ST pointing at a proxy that does not answer is not connected');
    assert.equal(facts(ours, 'pending').checking, true);
});

test('a brand-new install walks the steps as the facts change', () => {
    assert.equal(guideStep(boot(), facts(none, 'offline')), 1);
    assert.equal(guideStep(boot(), facts(none, 'nologin')), 2);
    assert.equal(guideStep(boot(), facts(none, 'online')), 3);
    assert.equal(guideStep(boot({ guideSource: 'on' }), facts(ours, 'online')), DONE_STEP);
});

test('only steps 1 and 2 poll the proxy', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(pollsProxy), [false, true, true, false, false]);
});

test('already connected and never started: no guide, marked done automatically', () => {
    assert.equal(guideStep(boot(), facts(ours, 'online')), 0);
    assert.equal(shouldAutoOnboard(boot(), facts(ours, 'online')), true);
    assert.equal(shouldAutoOnboard({ onboarded: true, guideSource: '' }, facts(ours, 'online')), false);
});

test('someone who started the guide and connects is NOT auto-marked: they see 完成', () => {
    assert.equal(shouldAutoOnboard(boot({ guideSource: 'on' }), facts(ours, 'online')), false);
    // older versions saved 'choose' / 'proxy': still a started guide
    for (const g of ['choose', 'proxy']) assert.equal(guideStep(boot({ guideSource: g }), facts(ours, 'online')), DONE_STEP);
});

test('onboarded: the guide never shows, whatever the facts', () => {
    for (const [c, p] of [[none, 'offline'], [none, 'nologin'], [ours, 'online']]) assert.equal(guideStep(boot({ onboarded: true }), facts(c, p)), 0);
});

test('returning users (settings existed, or connected once) never get it on their own', () => {
    for (const f of [facts(none, 'offline'), facts(none, 'nologin'), facts(ours, 'online')]) {
        assert.equal(guideStep(boot({ settingsExisted: true }), f), 0);
        assert.equal(guideStep(boot({ everConnected: true }), f), 0);
    }
});

test('重新引导 shows it for anyone, at the step the facts say', () => {
    const s = boot({ settingsExisted: true, everConnected: true, ...startGuide() });
    assert.equal(guideStep(s, facts(none, 'offline')), 1);
    assert.equal(guideStep(s, facts(none, 'nologin')), 2);
    assert.equal(guideStep(s, facts(ours, 'online')), DONE_STEP);
});

test('skipping or finishing ends it for good', () => {
    assert.deepEqual(finishGuide(), { onboarded: true, guideSource: '' });
    assert.equal(guideStep({ ...boot(), ...finishGuide() }, facts(none, 'offline')), 0);
});

test('fresh install whose ST already points at an offline proxy still gets the guide', () => {
    assert.equal(guideStep(boot(), facts(ours, 'offline')), 1);
    assert.equal(shouldAutoOnboard(boot(), facts(ours, 'offline')), false);
});

test('proxyUnknown / glanceLinked', () => {
    assert.equal(proxyUnknown('pending'), true);
    assert.equal(proxyUnknown('idle'), true);
    assert.equal(proxyUnknown('online'), false);
    assert.equal(glanceLinked(ours, 'offline'), false);
    assert.equal(glanceLinked(ours, 'online'), true);
    assert.equal(glanceLinked(none, 'online'), false);
});

test('the guide card replaces the connect card while it shows, and polls on steps 1-2', () => {
    const g = readFileSync(new URL('../src/panel/guide.js', import.meta.url), 'utf8');
    assert.match(g, /hideConnectCard: true/);
    assert.match(g, /setPolling\(pollsProxy\(step\)\)/);
    assert.match(g, /installHelp\(/);
    assert.match(g, /loginHelp\(/);
    assert.match(g, /connect\(getSettings\(\)\)/);
});
