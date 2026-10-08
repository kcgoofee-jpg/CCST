// ──────────────────────────────────────────────
// Setting the model on the proxy connection: one-click connect picks a Claude model when SillyTavern
// has none. Choosing a model is otherwise SillyTavern's own 「API 连接」 (presets save it).
// ──────────────────────────────────────────────

import { F } from '../core/registry.js';

// 审: 一键连接在酒馆没有 Claude 模型时，给代理连接设模型（优先改界面控件，没有则直接写设置）。
/** Switch SillyTavern's model on the proxy connection (its custom model field). `id` is canonical
 *  (claude-opus-4-6), optionally with [1m]. */
export function setModel(id) {
    const ctx = SillyTavern.getContext();
    const input = globalThis.jQuery?.('#custom_model_id');
    if (input?.length) input.val(id).trigger('input');
    else if (ctx.chatCompletionSettings) {
        ctx.chatCompletionSettings.custom_model = id;
        ctx.saveSettingsDebounced?.();
    }
    // The Custom source's model field doesn't raise CHATCOMPLETION_MODEL_CHANGED: apply the
    // preset's per-model entries here too.
    setTimeout(() => F.presets.applyModelProfile(), 150);
    return true;
}
