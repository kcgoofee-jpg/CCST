// Small DOM helpers shared by every tab.

// 审: 创建带 class/文本的元素，面板所有 DOM 构建的基础 helper。
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// 审: 彩色提示卡（info/warn/error/ok），颜色由 data-tone 决定。
/** Coloured note card: one class, the tone picks the colour (info | warn | error | ok). */
export function note(tone, title) {
    const box = el('div', 'cm-note');
    box.dataset.tone = tone;
    if (title) box.append(el('div', 'cm-note-title', title));
    return box;
}

// 审: 图标小按钮（刷新等），状态页用。
export function iconButton(iconClass, title, onClick) {
    const btn = el('div', `menu_button cm-icon-btn fa-solid ${iconClass}`);
    btn.title = title;
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.addEventListener('click', onClick);
    return btn;
}

// 审: 分段单选控件（缓存时长），选项的 hint 只做 tooltip。
/** Segmented control: one choice out of a few. An option's `hint` is its tooltip, never text on the page. */
export function segmented({ label, options, current, onChange }) {
    const wrap = el('div', 'cm-field');
    wrap.append(el('div', 'cm-field-label', label));
    const group = el('div', 'cm-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const buttons = options.map((opt) => {
        const b = el('button', 'cm-seg-btn', opt.label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        if (opt.hint) b.title = opt.hint;
        b.addEventListener('click', () => select(opt.value, true));
        group.append(b);
        return b;
    });
    function select(value, fire) {
        options.forEach((opt, i) => {
            const on = opt.value === value;
            buttons[i].classList.toggle('active', on);
            buttons[i].setAttribute('aria-checked', String(on));
            // A card that stops being the selected one must not keep a focus ring (it reads as selected).
            if (!on && buttons[i].matches?.(':focus')) buttons[i].blur();
        });
        if (fire) onChange(value);
    }
    select(current, false);
    wrap.append(group);
    return wrap;
}

// 审: 开关行：标题 + 右侧开关，tip 为可选 tooltip。
/** Toggle row: a short title, switch on the right. `tip` (optional) is a short tooltip for an option
 *  whose name alone is unclear; there is no text under the title. */
export function toggleRow({ id, title, tip, checked, onChange }) {
    const row = el('label', 'cm-toggle');
    row.htmlFor = id;
    if (tip) row.title = tip;
    const text = el('div', 'cm-toggle-text');
    text.append(el('div', 'cm-toggle-title', title));
    const input = el('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const sw = el('span', 'cm-switch');
    row.append(text, input, sw);
    return row;
}

// 审: 分组标题栏（标题 + 右侧工具），只被 group 用。
/** Section head: title, optional tools (icon buttons) on the right. */
function section(title, extra) {
    const head = el('div', 'cm-section-head');
    const text = el('div', 'cm-section-text');
    text.append(el('div', 'cm-section-title', title));
    head.append(text);
    if (extra) head.append(extra);
    return head;
}

// 审: 带标题的分组，返回 { root, body } 往 body 里放控件；两个标签页的基本骨架。
/** A section with its content: `group('上一轮', { tools })` → { root, body }. Append controls to `body`. */
export function group(title, { tools, id } = {}) {
    const root = el('section', 'cm-group');
    if (id) root.id = id;
    const body = el('div', 'cm-group-body');
    root.append(section(title, tools), body);
    return { root, body };
}

// 审: 加载中/空/出错的统一一行，出错时可带「重试」。
/** Empty / loading / error line, the same everywhere. `retry` adds a 重试 button (errors). */
export function stateLine(kind, text, retry) {
    const box = el('div', 'cm-state');
    box.dataset.kind = kind; // loading | empty | error
    box.append(el('small', 'cm-hint', text));
    if (retry) {
        const b = el('button', 'cm-link-btn', '重试');
        b.type = 'button';
        b.addEventListener('click', retry);
        box.append(b);
    }
    return box;
}

// 审: 面板统一的按钮样式，primary 用强调色。
/** A button: `primary` fills with the accent colour. Same look for every action in the panel. */
export function button(label, onClick, { icon, primary = false, text = false, id } = {}) {
    const b = el('button', `menu_button cm-btn${primary ? ' cm-primary' : ''}${text ? ' cm-btn-text' : ''}`);
    b.type = 'button';
    if (id) b.id = id;
    if (icon) b.append(el('i', `fa-solid ${icon}`));
    b.append(document.createTextNode(icon ? ` ${label}` : label));
    b.addEventListener('click', onClick);
    return b;
}

// 审: 折叠组（用量），desc 是折叠时可见的一行摘要。
/** A collapsed group; `desc` (optional) is a short line under its title, visible while folded (用量 puts its summary there).
 *  Returns { root, body }: append the group's content to `body`. */
export function collapsible(title, desc, { id } = {}) {
    const root = el('details', 'cm-details cm-fold');
    if (id) root.id = id;
    const head = el('summary');
    head.append(el('span', 'cm-fold-title', title));
    if (desc) head.append(el('small', 'cm-hint cm-fold-desc', desc));
    const body = el('div', 'cm-fold-body');
    root.append(head, body);
    return { root, body };
}
