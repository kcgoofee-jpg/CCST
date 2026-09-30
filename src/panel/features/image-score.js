// Slash command /图分 (see the comment below); the score rides on the message for the turn report.

import { notify } from '../core/notify.js';

// /图分 1–5: the user's own rating of this reply's images, stored on the
// latest AI message (extra.cm_img_score) for the turn report. We never
// look at the images ourselves; the score is the only signal.
export function registerImageScore() {
    const ctx = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: '图分',
        aliases: ['imgscore'],
        helpString: '给最新一楼的图打分（1–5，准不准），记在这条消息上，供逐楼报表统计。例：/图分 4',
        unnamedArgumentList: SlashCommandArgument?.fromProps
            ? [SlashCommandArgument.fromProps({ description: '1–5', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: true })]
            : [],
        callback: async (_args, value) => {
            const n = Number(String(value ?? '').trim());
            if (!Number.isInteger(n) || n < 1 || n > 5) {
                notify('warn', '图分是 1–5 的整数', '例：/图分 4');
                return '';
            }
            const c = SillyTavern.getContext();
            const chat = c.chat ?? [];
            for (let i = chat.length - 1; i >= 0; i--) {
                const m = chat[i];
                if (m.is_user || m.is_system) continue;
                m.extra = { ...(m.extra ?? {}), cm_img_score: n };
                await c.saveChat?.();
                notify('ok', `第 ${i} 楼的图：${n} 分`, '', { ms: 2500 });
                return String(n);
            }
            notify('warn', '还没有 AI 回复');
            return '';
        },
    }));
}
