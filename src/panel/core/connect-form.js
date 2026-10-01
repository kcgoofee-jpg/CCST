// ──────────────────────────────────────────────
// 「连不上代理」卡片里「粘贴手机连接码 → 连接」的逻辑（纯逻辑：依赖都从外面传进来，测试用假的）。
// 连接码拆成地址和访问密码，存到和「其他 → 手机连接」同一组设置（settings.endpoint / settings.accessKey；
// 一键连接把访问密码写进酒馆的自定义接口密钥，用的就是这个设置），然后立刻重新检测；
// 结果按代理自己的回答分：连上了 / 连接码里的密码不对 / 连不上。
// ──────────────────────────────────────────────

import { parseConnectCode } from './connect-code.js';
import { connectOutcome } from './connect-help.js';

/**
 * @param {{ code: string }} input
 * @param {{ settings: object, save: () => void, sync?: (s: object) => void, refresh: () => Promise<void>, getStatus: () => object, connect?: (s: object) => unknown }} deps
 * @returns {Promise<{ kind: 'ok'|'denied'|'offline'|'empty'|'bad', text: string }>}
 */
export async function submitConnect({ code }, { settings, save, sync, refresh, getStatus, connect }) {
    if (!String(code ?? '').trim()) return { kind: 'empty', text: '先粘贴电脑上显示的手机连接码' };
    const parsed = parseConnectCode(code);
    if (!parsed) return { kind: 'bad', text: '没认出连接码：请把整行粘贴过来' };
    settings.endpoint = parsed.endpoint;
    settings.accessKey = parsed.accessKey;
    sync?.(settings);
    save();
    await refresh();
    const status = getStatus();
    const out = connectOutcome(status);
    // Reached the proxy and it is ready: go on to the normal one-click connect (which asks before changing ST).
    if (out.kind === 'ok' && status.phase === 'online') await connect?.(settings);
    return out;
}

/** Open a collapsed group inside a tab and focus its first input (the one place that knows how; used by every「去…」jump). */
export function revealGroup({ showTab, tab, groupId, doc = document }) {
    showTab(tab);
    const group = doc.getElementById(groupId);
    if (!group) return false;
    group.open = true;
    const input = group.querySelector('input');
    group.scrollIntoView?.({ block: 'nearest' });
    if (input) input.focus?.({ preventScroll: true });
    return true;
}
