// The panel's tab list and the migration of saved tab keys (pure: no DOM, no ST; the tests import it).

export const TABS = [['status', '状态'], ['settings', '设置']];
export const DEFAULT_TAB = 'status';

// Keys saved by earlier versions map onto their successors: 3.1 renamed 统计 / 更多; 4.0 folded the
// Mac tab into 其他; 5.0 dropped 体检 (its reliable checks live in 状态).
// 5.3: 推理 became 聊天, and 其他 was folded into 设置. 6.1: 聊天 went (model and thinking are SillyTavern's own).
export const OLD_TABS = { stats: 'status', adv: 'settings', mac: 'settings', check: 'status', reason: 'status', other: 'settings', chat: 'status' };

/** A saved key (localStorage) → a tab that exists; anything unknown → 状态. */
export function resolveTab(key) {
    const k = OLD_TABS[key] ?? key;
    return TABS.some(([t]) => t === k) ? k : DEFAULT_TAB;
}
