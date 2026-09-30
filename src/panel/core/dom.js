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

/** Segmented control: one choice out of a few, hint text follows it. */
export function segmented({ label, options, current, onChange }) {
    const wrap = el('div', 'cm-field');
    wrap.append(el('div', 'cm-field-label', label));
    const group = el('div', 'cm-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const hint = el('small', 'cm-hint');
    const buttons = options.map((opt) => {
        const b = el('button', 'cm-seg-btn', opt.label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => select(opt.value, true));
        group.append(b);
        return b;
    });
    function select(value, fire) {
        options.forEach((opt, i) => {
            const on = opt.value === value;
            buttons[i].classList.toggle('active', on);
            buttons[i].setAttribute('aria-checked', String(on));
            if (on) hint.textContent = opt.hint;
        });
        if (fire) onChange(value);
    }
    select(current, false);
    wrap.append(group, hint);
    wrap.select = (value) => select(value, false);
    return wrap;
}

/** Toggle row: title + one-line description, switch on the right.
 *  `more` (optional) is the long explanation, behind a「说明」link. */
export function toggleRow({ id, title, desc, more, checked, onChange }) {
    const row = el('label', 'cm-toggle');
    row.htmlFor = id;
    const text = el('div', 'cm-toggle-text');
    const hint = el('small', 'cm-hint', desc);
    text.append(el('div', 'cm-toggle-title', title), hint);
    const input = el('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const sw = el('span', 'cm-switch');
    row.append(text, input, sw);
    if (!more) return row;
    const moreText = el('small', 'cm-hint cm-more-text', more);
    moreText.hidden = true;
    const link = el('a', 'cm-more', '说明');
    link.href = '#';
    link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        moreText.hidden = !moreText.hidden;
        link.textContent = moreText.hidden ? '说明' : '收起';
    });
    hint.append(' ', link);
    const wrap = el('div', 'cm-toggle-wrap');
    wrap.append(row, moreText);
    return wrap;
}

export function section(title, extra) {
    const head = el('div', 'cm-section-head');
    head.append(el('div', 'cm-section-title', title));
    if (extra) head.append(extra);
    return head;
}

/** A collapsed group with a one-line description under its title (visible while folded).
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
