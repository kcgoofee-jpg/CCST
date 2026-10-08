// The panel's tab list and the migration of saved tab keys (pure: no DOM, no ST; the tests import it).

// 审: 现存的两个标签页 [键, 名]；shell 据此建标签栏。
export const TABS = [['status', '状态'], ['settings', '设置']];
// 审: 未知/过期的标签键落到的默认页。
const DEFAULT_TAB = 'status';

// 审: 历史版本存下的标签键 → 现存标签页的迁移表，localStorage 里可能还留着旧键；测试引用。
// Keys saved by earlier versions map onto their successors: 3.1 renamed 统计 / 更多; 4.0 folded the
// Mac tab into 其他; 5.0 dropped 体检 (its reliable checks live in 状态).
// 5.3: 推理 became 聊天, and 其他 was folded into 设置. 6.1: 聊天 went (model and thinking are SillyTavern's own).
export const OLD_TABS = { stats: 'status', adv: 'settings', mac: 'settings', check: 'status', reason: 'status', other: 'settings', chat: 'status' };

// 审: 存下的标签键 → 一个确实存在的标签页，未知回到状态。
/** A saved key (localStorage) → a tab that exists; anything unknown → 状态. */
export function resolveTab(key) {
    const k = OLD_TABS[key] ?? key;
    return TABS.some(([t]) => t === k) ? k : DEFAULT_TAB;
}
