// Small DOM helpers shared by every tab.

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Coloured note card: one class, the tone picks the colour (info | warn | error | ok). */
export function note(tone, title) {
    const box = el('div', 'cm-note');
    box.dataset.tone = tone;
    if (title) box.append(el('div', 'cm-note-title', title));
    return box;
}

export function iconButton(iconClass, title, onClick) {
    const btn = el('div', `menu_button cm-icon-btn fa-solid ${iconClass}`);
    btn.title = title;
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.addEventListener('click', onClick);
    return btn;
}

/** Popup text as DOM nodes: names come from the card and must not be parsed as HTML. */
export function popupText(...lines) {
    const box = el('div');
    for (const line of lines) box.append(el('p', null, line));
    return box;
}

/** Segmented control: one choice out of a few. An option's `hint` is its tooltip, never text on the page. */
export function segmented({ label, options, current, onChange, hideLabel = false }) {
    const wrap = el('div', 'cm-field');
    wrap.append(el('div', hideLabel ? 'cm-field-label cm-sr' : 'cm-field-label', label));
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
    const why = el('small', 'cm-hint');
    why.hidden = true;
    wrap.append(group, why);
    wrap.select = (value) => select(value, false);
    // Grey an option out (it stays visible) and say why in one short line; `reason` falsy re-enables it.
    wrap.setDisabled = (value, reason) => {
        options.forEach((opt, i) => {
            if (opt.value !== value) return;
            buttons[i].disabled = !!reason;
            buttons[i].title = reason || opt.hint || '';
            buttons[i].dataset.why = reason || '';
        });
        const reasons = [...new Set(buttons.map((b) => b.disabled && b.dataset.why).filter(Boolean))];
        why.textContent = reasons.join(' ');
        why.hidden = !reasons.length;
    };
    return wrap;
}

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

/** Section head: title, optional tools (icon buttons) on the right. */
export function section(title, extra) {
    const head = el('div', 'cm-section-head');
    const text = el('div', 'cm-section-text');
    text.append(el('div', 'cm-section-title', title));
    head.append(text);
    if (extra) head.append(extra);
    return head;
}

/** A section with its content: `group('上一轮', { tools })` → { root, body }. Append controls to `body`. */
export function group(title, { tools, id } = {}) {
    const root = el('section', 'cm-group');
    if (id) root.id = id;
    const body = el('div', 'cm-group-body');
    root.append(section(title, tools), body);
    return { root, body };
}

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

/** Radio rows: one choice out of a few, each a name and at most a short tag (「最稳」). Same `.select(value)` as segmented(). */
export function cards({ label, options, current, onChange }) {
    const wrap = el('div', 'cm-field');
    if (label) wrap.append(el('div', 'cm-field-label', label));
    const list = el('div', 'cm-cards');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', label);
    const buttons = options.map((opt) => {
        const b = el('button', 'cm-card');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        if (opt.hint) b.title = opt.hint;
        b.append(el('span', 'cm-card-dot'), el('span', 'cm-card-title', opt.label));
        if (opt.tag) b.append(el('small', 'cm-card-tag', opt.tag));
        b.addEventListener('click', () => select(opt.value, true));
        list.append(b);
        return b;
    });
    function select(value, fire) {
        options.forEach((opt, i) => {
            const on = opt.value === value;
            buttons[i].classList.toggle('active', on);
            buttons[i].setAttribute('aria-checked', String(on));
        });
        if (fire) onChange(value);
    }
    select(current, false);
    wrap.append(list);
    wrap.select = (value) => select(value, false);
    return wrap;
}

/** A collapsed group; `desc` (optional) is a short line under its title, visible while folded (用量 puts its summary there).
 *  Returns { root, body }: append the group's content to `body`. */
export function collapsible(title, desc, { id, open = false } = {}) {
    const root = el('details', 'cm-details cm-fold');
    if (id) root.id = id;
    root.open = open;
    const head = el('summary');
    head.append(el('span', 'cm-fold-title', title));
    if (desc) head.append(el('small', 'cm-hint cm-fold-desc', desc));
    const body = el('div', 'cm-fold-body');
    root.append(head, body);
    return { root, body };
}
