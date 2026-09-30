// Small readers of SillyTavern's own state.

export function currentCharKey() {
    const ctx = SillyTavern.getContext();
    return ctx.groupId ? `group:${ctx.groupId}` : (ctx.characters?.[ctx.characterId]?.avatar ?? 'default');
}

/** Is SillyTavern generating right now (body[data-generating], stop button up)? */
export function generating() {
    if (document.body.dataset.generating === 'true') return true;
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}
