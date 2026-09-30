import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_ENDPOINT, normalizeEndpoint, isOurEndpoint, stSideEndpoint, proxyBaseOf, detectPlatform, isPhoneLike,
    quietRenderMode, quietRenderOn, proxyDirectOnly, cloudHosted, canSyncPhone, resolveConnection, classifyRequest, debugViewState, PHONE_SYNC_WARNING, PHONE_SYNC_LABEL,
} from '../src/panel/core/capabilities.js';
import * as hostCheck from '../src/shared/host.js';
import * as sources from '../src/shared/sources.js';
import { versionMismatch } from '../src/panel/core/live.js';

test('endpoint helpers: trailing slashes, ours, proxy base', () => {
    assert.equal(normalizeEndpoint('  http://127.0.0.1:8901/v1// '), 'http://127.0.0.1:8901/v1');
    assert.equal(normalizeEndpoint(null), '');
    assert.equal(isOurEndpoint('http://127.0.0.1:8901/v1/', { endpoint: DEFAULT_ENDPOINT }), true);
    assert.equal(isOurEndpoint('', { endpoint: '' }), false);
    assert.equal(isOurEndpoint('http://x/v1', { endpoint: DEFAULT_ENDPOINT }), false);
    assert.equal(proxyBaseOf('http://192.168.1.5:8901/v1/'), 'http://192.168.1.5:8901');
    assert.equal(proxyBaseOf('http://host:8901'), 'http://host:8901');
});

test('detectPlatform reads a window-like object; no window means nothing detected', () => {
    assert.deepEqual(detectPlatform(undefined), { tauri: false, coarse: false, hostname: '' });
    const win = { __TAURITAVERN__: {}, matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }), location: { hostname: 'tauri.localhost' } };
    assert.deepEqual(detectPlatform(win), { tauri: true, coarse: true, hostname: 'tauri.localhost' });
    assert.deepEqual(detectPlatform({ matchMedia: () => undefined, location: { hostname: 'h' } }), { tauri: false, coarse: false, hostname: 'h' });
});

test('phone-like and 省电显示 (quiet render) decisions', () => {
    const desktop = { tauri: false, coarse: false };
    const phone = { tauri: false, coarse: true };
    const tauri = { tauri: true, coarse: false };
    assert.equal(isPhoneLike(desktop), false);
    assert.equal(isPhoneLike(phone), true);
    assert.equal(isPhoneLike(tauri), true);
    assert.equal(quietRenderMode('on'), 'on');
    assert.equal(quietRenderMode('off'), 'off');
    assert.equal(quietRenderMode('auto'), 'auto');
    assert.equal(quietRenderMode(true), 'auto');
    assert.equal(quietRenderMode(undefined), 'auto');
    // auto follows the device; on / off override it
    assert.equal(quietRenderOn('auto', desktop), false);
    assert.equal(quietRenderOn('auto', phone), true);
    assert.equal(quietRenderOn('auto', tauri), true);
    assert.equal(quietRenderOn('on', desktop), true);
    assert.equal(quietRenderOn('off', phone), false);
    assert.equal(quietRenderOn(undefined, phone), true);
});

test('the plugin route is only a fallback on the default endpoint outside TauriTavern', () => {
    assert.equal(proxyDirectOnly({ tauri: false, endpoint: DEFAULT_ENDPOINT }), false);
    assert.equal(proxyDirectOnly({ tauri: false, endpoint: `${DEFAULT_ENDPOINT}/` }), false);
    assert.equal(proxyDirectOnly({ tauri: true, endpoint: DEFAULT_ENDPOINT }), true);
    assert.equal(proxyDirectOnly({ tauri: false, endpoint: 'http://192.168.1.5:8901/v1' }), true);
});

test('cloud-hosted SillyTavern is only reported when the helper is loaded', () => {
    const args = { hostname: 'my.tavern.example.com', endpoint: DEFAULT_ENDPOINT, tauri: false };
    assert.equal(cloudHosted(null, args), false);
    assert.equal(cloudHosted(hostCheck, args), true);
    assert.equal(cloudHosted(hostCheck, { ...args, hostname: '192.168.1.5' }), false);
    assert.equal(cloudHosted(hostCheck, { ...args, tauri: true }), false);
});

test('phone sync needs a phone-mode proxy and TauriTavern', () => {
    assert.equal(canSyncPhone({ phoneMode: true }, { tauri: true }), true);
    assert.equal(canSyncPhone({ phoneMode: true }, { tauri: false }), false);
    assert.equal(canSyncPhone({ phoneMode: false }, { tauri: true }), false);
    assert.equal(canSyncPhone(null, { tauri: true }), false);
});

const settings = { endpoint: DEFAULT_ENDPOINT };

test('resolveConnection: this proxy, Claude direct, other', () => {
    const ours = resolveConnection({ mainApi: 'openai', oai: { chat_completion_source: 'custom', custom_url: DEFAULT_ENDPOINT, custom_model: 'claude-opus-5-5' }, settings, sources });
    assert.deepEqual([ours.kind, ours.connected, ours.direct, ours.model, ours.where, ours.billing], ['ours', true, false, 'claude-opus-5-5', '本机代理', '订阅']);

    const claude = resolveConnection({ mainApi: 'openai', oai: { chat_completion_source: 'claude', claude_model: 'claude-opus-4-6' }, settings, sources });
    assert.deepEqual([claude.kind, claude.connected, claude.direct, claude.model, claude.where], ['claude', false, true, 'claude-opus-4-6', 'Claude 官方']);

    const relay = resolveConnection({ mainApi: 'openai', oai: { chat_completion_source: 'claude', claude_model: 'claude-opus-4-6', reverse_proxy: 'https://relay' }, settings, sources });
    assert.equal(relay.where, '反向代理');

    const other = resolveConnection({ mainApi: 'openai', oai: { chat_completion_source: 'custom', custom_url: 'http://llama:8080/v1', custom_model: 'llama' }, settings, sources });
    assert.deepEqual([other.kind, other.connected, other.direct, other.model], ['other', false, false, null]);

    const textApi = resolveConnection({ mainApi: 'textgenerationwebui', oai: { chat_completion_source: 'claude', claude_model: 'claude-opus-4-6' }, settings, sources });
    assert.equal(textApi.kind, 'other');
});

test('resolveConnection without the sources helper knows the Claude source and OpenRouter only', () => {
    const r = (oai) => resolveConnection({ mainApi: 'openai', oai, settings, sources: null });
    assert.equal(r({ chat_completion_source: 'claude', claude_model: 'claude-x' }).direct, true);
    assert.equal(r({ chat_completion_source: 'openrouter', openrouter_model: 'anthropic/claude-opus-4.6' }).kind, 'openrouter');
    assert.equal(r({ chat_completion_source: 'openrouter', openrouter_model: 'meta/llama' }).direct, false);
    assert.equal(r({ chat_completion_source: 'nanogpt', nanogpt_model: 'claude-opus-4-6' }).direct, false);
    assert.equal(r({ chat_completion_source: 'custom', custom_url: `${DEFAULT_ENDPOINT}/` }).connected, true);
});

test('classifyRequest: ours / direct to Claude / someone else', () => {
    const req = (source, model, url = '') => classifyRequest({ chat_completion_source: source, model, custom_url: url }, settings, sources);
    assert.deepEqual(req('custom', 'claude-opus-5-5', DEFAULT_ENDPOINT), { ours: true, direct: false });
    assert.deepEqual(req('claude', 'claude-opus-5-5'), { ours: false, direct: true });
    assert.deepEqual(req('openrouter', 'anthropic/claude-opus-4.6'), { ours: false, direct: true });
    assert.deepEqual(req('openrouter', 'meta/llama'), { ours: false, direct: false });
    assert.deepEqual(req('custom', 'claude-opus-5-5', 'http://other:1/v1'), { ours: false, direct: true }); // a Claude model on a custom address
    assert.deepEqual(req('custom', 'llama', 'http://other:1/v1'), { ours: false, direct: false });
    assert.deepEqual(classifyRequest({ chat_completion_source: 'claude', model: 'x' }, settings, null), { ours: false, direct: true });
});

test('versionMismatch: same major.minor is fine, otherwise names the side that is behind', () => {
    assert.equal(versionMismatch('3.4.1', '3.4.9'), null);
    assert.equal(versionMismatch(null, '3.4.1'), null);
    assert.equal(versionMismatch('3.4.1', null), null);
    assert.match(versionMismatch('3.3.0', '3.4.1'), /代理 v3\.3\.0 比面板 v3\.4\.1 旧/);
    assert.match(versionMismatch('3.5.0', '3.4.1'), /面板 v3\.4\.1 比代理 v3\.5\.0 旧/);
    assert.match(versionMismatch('2.9.0', '3.0.0'), /代理 v2\.9\.0 比面板/);
});

test('debugViewState: the view button needs 保存最近一次完整请求', () => {
    assert.deepEqual(debugViewState({ debugDump: true }), { enabled: true, hint: '' });
    const off = debugViewState({ debugDump: false });
    assert.equal(off.enabled, false);
    assert.match(off.hint, /先打开上面的开关，再聊一轮/);
    assert.equal(debugViewState(undefined).enabled, false);
});

test('phone sync in TauriTavern: untested warning and button label', () => {
    assert.match(PHONE_SYNC_WARNING, /自带同步和备份/);
    assert.match(PHONE_SYNC_WARNING, /还没测试过/);
    assert.equal(PHONE_SYNC_LABEL, '仍要同步（未测试）');
});

test('genLine: the status bar text for thinking, writing, done, idle', async () => {
    const { genLine } = await import('../src/panel/core/capabilities.js');
    assert.equal(genLine({ kind: 'idle' }), '');
    assert.equal(genLine(undefined), '');
    assert.equal(genLine({ kind: 'thinking', startedAt: Date.now() - 12400 }), '思考中 12 秒');
    assert.equal(genLine({ kind: 'writing', chars: 1234 }), '写作中 1,234 字');
    assert.equal(genLine({ kind: 'done', chars: 1850, seconds: 38, cache: 94 }), '完成 · 1,850 字 · 38 秒 · 缓存 94%');
    assert.equal(genLine({ kind: 'done', chars: 900, seconds: null, cache: null }), '完成 · 900 字');
});

test('split deployment: SillyTavern-side address also counts as ours', () => {
    const st = { endpoint: 'https://ccst.example.com/v1', stEndpoint: 'http://ccst:8901/v1/' };
    assert.equal(isOurEndpoint('http://ccst:8901/v1', st), true);
    assert.equal(isOurEndpoint('https://ccst.example.com/v1', st), true);
    assert.equal(isOurEndpoint('http://other/v1', st), false);
    assert.equal(stSideEndpoint(st), 'http://ccst:8901/v1');
    assert.equal(stSideEndpoint({ endpoint: DEFAULT_ENDPOINT }), DEFAULT_ENDPOINT);
});
