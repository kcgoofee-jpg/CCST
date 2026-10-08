// Small readers of SillyTavern's own state.

// 审: 酒馆此刻是否在生成（data-generating 或停止按钮可见），回复保管和进度条用来避免打断。
/** Is SillyTavern generating right now (body[data-generating], stop button up)? */
export function generating() {
    if (document.body.dataset.generating === 'true') return true;
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}
