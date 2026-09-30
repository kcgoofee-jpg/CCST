// The panel's tab list and the migration of saved tab keys (pure: no DOM, no ST; the tests import it).

export const TABS = [['reason', '推理'], ['status', '状态'], ['check', '体检'], ['settings', '设置'], ['other', '其他']];
export const DEFAULT_TAB = 'reason';

// Keys saved by earlier versions map onto their successors: 3.1 renamed 统计 / 更多; 4.0 folded the
// Mac tab into 其他 (a saved 'mac' lands on 其他, where the Mac section now lives).
export const OLD_TABS = { stats: 'status', adv: 'settings', mac: 'other' };

/** A saved key (localStorage, or the pre-3.1 setting) → a tab that exists; anything unknown → 推理. */
export function resolveTab(key) {
    const k = OLD_TABS[key] ?? key;
    return TABS.some(([t]) => t === k) ? k : DEFAULT_TAB;
}
