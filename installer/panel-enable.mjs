// 一键安装用：酒馆里把 CCST 面板停用了（扩展 → 管理扩展 里关掉）就重新启用。
//   node panel-enable.mjs <酒馆文件夹> [--check]
// 每个用户的 data/<用户>/settings.json 里 extension_settings.disabledExtensions 去掉 CCST 那一项，先备份。
// --check 只列出停用了的用户，不改。输出每行一个用户名；出错不影响安装（退出码 0）。
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [st, flag] = process.argv.slice(2);
const isCcst = (name) => /(^|\/)CCST$/.test(String(name));
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

let users = [];
try { users = readdirSync(join(st, 'data'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 没有 data */ }
for (const user of users) {
    const file = join(st, 'data', user, 'settings.json');
    try {
        const json = JSON.parse(readFileSync(file, 'utf8'));
        const list = json?.extension_settings?.disabledExtensions;
        if (!Array.isArray(list) || !list.some(isCcst)) continue;
        if (flag !== '--check') {
            copyFileSync(file, `${file}.ccst-backup-${stamp}`);
            json.extension_settings.disabledExtensions = list.filter((x) => !isCcst(x));
            writeFileSync(file, JSON.stringify(json, null, 4));
        }
        console.log(user);
    } catch { /* 没有或读不了：跳过 */ }
}
