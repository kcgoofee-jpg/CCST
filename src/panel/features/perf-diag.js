// ──────────────────────────────────────────────
// Performance diagnosis: what in this page keeps the phone busy (体检 → 性能)
// Counts running animations, embedded frames and frosted-glass elements per chat floor, then samples the
// frame rate and long tasks for a few seconds. Reported to the proxy (the Mac reads it); numbers only.
// ──────────────────────────────────────────────

import { getSettings, quietOn } from '../core/settings.js';
import { IS_TAURI, quietRenderMode } from '../core/capabilities.js';
import { controlFetch } from '../core/proxy.js';
import { el, note } from '../core/dom.js';

/** 体检 → 性能: what 省电显示 is doing right now, and why. */
export function renderPerfNote(note = document.getElementById('claude_max_perf_note')) {
    if (!note) return;
    const mode = quietRenderMode(getSettings().quietRender);
    const why = mode === 'auto' ? `自动${quietOn() ? '，手机 / TauriTavern' : '，电脑'}` : '手动';
    note.textContent = quietOn()
        ? `省电显示开（${why}）：旧楼层动画只播一遍、不做毛玻璃。`
        : `省电显示关（${why}）。在「设置 → 调试选项」可改。`;
}

export async function showPerfDiag() {
    let box = document.getElementById('claude_max_perf');
    if (!box) return;
    box.replaceChildren(el('small', 'cm-hint', '正在测（约 4 秒，别滑动）…'));
    const r = await runPerfDiag();
    box = document.getElementById('claude_max_perf');
    if (!box) return;
    const card = note(r.fps < 30 || r.topInfinite.length > 5 ? 'warn' : 'ok', `帧率 ${r.fps}/秒 · 循环动画 ${r.topInfinite.reduce((n, [, c]) => n + c, 0)} · 毛玻璃 ${r.backdropBlur}`);
    card.append(el('small', 'cm-hint', `显示 ${r.floorsShown}/${r.chatLength} 楼 · 内嵌窗口 ${r.iframes} 个 · 页面元素 ${r.domNodes} 个 · 卡顿 ${r.longTasks} 次（${r.longTaskMs} ms）`));
    const floors = Object.entries(r.perFloor)
        .map(([f, t]) => [f, (t.infiniteAnimations ?? 0) * 3 + (t.iframes ?? 0) * 2 + (t.backdropBlur ?? 0), t])
        .filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [f, , t] of floors) {
        card.append(el('small', 'cm-hint', `${f === 'page' ? '聊天之外' : `第 ${f} 楼`}：循环动画 ${t.infiniteAnimations ?? 0} · 内嵌窗口 ${t.iframes ?? 0} · 毛玻璃 ${t.backdropBlur ?? 0}`));
    }
    if (!quietOn() && floors.length > 2) {
        card.append(el('small', 'cm-hint cm-warn', '旧楼层还在播动画：酒馆助手「渲染深度」设 3 左右，或在「设置 → 调试选项」把省电显示设为「开」。'));
    }
    box.replaceChildren(card);
}

export async function runPerfDiag() {
    const floorOf = (el) => el?.closest?.('#chat .mes')?.getAttribute('mesid') ?? 'page';
    const tally = {};
    const bump = (floor, key, n = 1) => {
        tally[floor] ??= {};
        tally[floor][key] = (tally[floor][key] ?? 0) + n;
    };
    const selectorOf = (el) => (el && el.nodeType === 1)
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`
        : '?';
    const topAnims = {};
    const countAnims = (doc, floor) => {
        for (const a of doc.getAnimations?.() ?? []) {
            if (a.playState !== 'running') continue;
            const target = a.effect?.target;
            const f = floor ?? floorOf(target);
            const infinite = a.effect?.getTiming?.().iterations === Infinity;
            bump(f, infinite ? 'infiniteAnimations' : 'animations');
            if (infinite) {
                const k = `${f} ${selectorOf(target)} ${a.animationName ?? ''}`.trim();
                topAnims[k] = (topAnims[k] ?? 0) + 1;
            }
        }
    };
    countAnims(document, null);
    let crossOrigin = 0;
    for (const fr of document.querySelectorAll('iframe')) {
        const f = floorOf(fr);
        bump(f, 'iframes');
        try {
            const d = fr.contentDocument;
            if (d) countAnims(d, f); else crossOrigin++;
        } catch { crossOrigin++; }
    }
    let blur = 0;
    for (const el of document.querySelectorAll('#chat *')) {
        const cs = getComputedStyle(el);
        if ((cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')) {
            blur++;
            bump(floorOf(el), 'backdropBlur');
        }
    }
    // Frame rate and long tasks over 4 s.
    let frames = 0;
    let longTasks = 0;
    let longMs = 0;
    let po = null;
    try {
        po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks++; longMs += e.duration; } });
        po.observe({ entryTypes: ['longtask'] });
    } catch { po = null; }
    const t0 = performance.now();
    await new Promise((resolve) => {
        const tick = () => { frames++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
    });
    po?.disconnect();
    const secs = (performance.now() - t0) / 1000;
    const ctx = SillyTavern.getContext();
    return {
        ok: true,
        app: IS_TAURI ? 'TauriTavern' : 'SillyTavern',
        visible: !document.hidden,
        fps: Math.round(frames / secs),
        longTasks, longTaskMs: Math.round(longMs),
        domNodes: document.getElementsByTagName('*').length,
        floorsShown: document.querySelectorAll('#chat .mes').length,
        chatLength: ctx.chat?.length ?? 0,
        iframes: document.querySelectorAll('iframe').length,
        crossOriginFrames: crossOrigin,
        backdropBlur: blur,
        perFloor: tally,
        topInfinite: Object.entries(topAnims).sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
}

export async function diagIfAsked() {
    try {
        const res = await controlFetch('/v1/control/diag-request');
        if (!res.ok || !(await res.json()).requested) return;
        const result = await runPerfDiag();
        await controlFetch('/v1/control/diag', result);
    } catch { /* proxy unreachable or not the launcher's: nothing to do */ }
}
