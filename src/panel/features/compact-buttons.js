// 输入栏脚本按钮并排显示 (the class is styled in style.css)

import { getSettings } from '../core/settings.js';

export function applyCompactButtons() {
    document.body.classList.toggle('cm-compact-qr', !!getSettings().compactScriptButtons);
}
