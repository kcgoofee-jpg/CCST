import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../installer/', import.meta.url));

test('Mac zip holds the current .command, executable (rebuild: python3 scripts/build-installer-zip.py)', (t) => {
    let listing;
    try { listing = execFileSync('unzip', ['-Z', `${dir}CCST-mac.zip`], { encoding: 'utf8' }); } catch { return t.skip('no unzip'); }
    assert.match(listing, /^-rwxr-xr-x/m);
    const inside = execFileSync('unzip', ['-p', `${dir}CCST-mac.zip`]);
    assert.ok(inside.equals(readFileSync(`${dir}CCST安装.command`)), 'zip is stale: run scripts/build-installer-zip.py');
});

test('Windows installer: .ps1 has a UTF-8 BOM, .bat is CRLF and finds the .ps1', () => {
    const ps1 = readFileSync(`${dir}ccst-install.ps1`);
    assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const bat = readFileSync(`${dir}CCST安装.bat`, 'utf8');
    assert.ok(bat.includes('\r\n') && !/[^\r]\n/.test(bat), 'CRLF only');
    assert.match(bat, /ccst-install\.ps1/);
    assert.match(bat, /-ExecutionPolicy Bypass/);
});

test('both installers say the fixed closing line and only touch enableServerPlugins in config', () => {
    for (const f of ['CCST安装.command', 'ccst-install.ps1']) {
        const s = readFileSync(`${dir}${f}`, 'utf8');
        assert.ok(s.includes('装好了。关掉酒馆再打开，面板会自动连上。'), f);
        assert.ok(!/rm -rf "\$ST|Remove-Item[^\n]*\$St\b/.test(s), `${f} must not delete inside the tavern folder`);
    }
});

test('Mac installer end to end on a fake tavern: config edited once (backed up), plugin installed, idempotent', (t) => {
    try { execFileSync('zsh', ['-c', 'exit 0']); execFileSync('git', ['--version']); } catch { return t.skip('needs zsh + git'); }
    const root = mkdtempSync(`${tmpdir()}/ccst-inst-`);
    try {
        const st = `${root}/home/SillyTavern`;
        mkdirSync(`${st}/default`, { recursive: true });
        writeFileSync(`${st}/server.js`, '');
        writeFileSync(`${st}/package.json`, '{ "name": "sillytavern" }');
        const cfg = 'port: 8000\nenableServerPlugins: false # 插件\nenableServerPluginsAutoUpdate: true\n';
        writeFileSync(`${st}/config.yaml`, cfg);
        const repo = `${root}/repo`;
        mkdirSync(repo);
        writeFileSync(`${repo}/package.json`, '{ "name": "fake-ccst", "version": "0.0.0" }');
        // Under the pre-commit hook git exports GIT_INDEX_FILE / GIT_DIR; the throwaway repo must not inherit them
        // (it would run `git add .` against the real index).
        const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
        const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { env: cleanEnv });
        git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'x');
        const env = { PATH: process.env.PATH, HOME: `${root}/home`, CCST_NO_PROCESS_SCAN: '1', CCST_SKIP_LOGIN: '1', CCST_YES: '1', CCST_REPO_URL: repo };
        const run = () => execFileSync('zsh', [`${dir}CCST安装.command`], { env, encoding: 'utf8' });
        // 旧版本留下的：别的文件夹里的旧插件、旧面板、旧 Mac 启动器的开机自启
        mkdirSync(`${st}/plugins/SillyTavern-ClaudeMax`, { recursive: true });
        writeFileSync(`${st}/plugins/SillyTavern-ClaudeMax/index.js`, "export const info = { id: 'claude-subscription' };");
        mkdirSync(`${st}/plugins/other`, { recursive: true });
        writeFileSync(`${st}/plugins/other/index.js`, "export const info = { id: 'other' };");
        mkdirSync(`${st}/public/scripts/extensions/third-party/SillyTavern-ClaudeSubscription`, { recursive: true });
        mkdirSync(`${root}/home/Library/LaunchAgents`, { recursive: true });
        writeFileSync(`${root}/home/Library/LaunchAgents/com.claudemax.autostart.plist`, '<plist/>');
        mkdirSync(`${root}/home/Desktop`);
        const out = run();
        assert.ok(out.includes('装好了。关掉酒馆再打开，面板会自动连上。'));
        assert.ok(readFileSync(`${root}/home/Desktop/CCST安装日志.txt`, 'utf8').includes('装好了。'), 'log on the Desktop');
        const bak = readdirSync(st).find((f) => f.startsWith('CCST旧版备份-'));
        assert.deepEqual(readdirSync(`${st}/${bak}`).sort(), ['LaunchAgents-com.claudemax.autostart.plist', 'plugins-SillyTavern-ClaudeMax', 'third-party-SillyTavern-ClaudeSubscription']);
        assert.ok(existsSync(`${st}/plugins/other/index.js`), 'unrelated plugins stay');
        assert.equal(readFileSync(`${st}/config.yaml`, 'utf8'), cfg.replace('enableServerPlugins: false', 'enableServerPlugins: true'));
        const backups = readdirSync(st).filter((f) => f.startsWith('config.yaml.ccst-backup-'));
        assert.equal(backups.length, 1);
        assert.equal(readFileSync(`${st}/${backups[0]}`, 'utf8'), cfg);
        assert.ok(existsSync(`${st}/plugins/CCST/package.json`));
        writeFileSync(`${st}/plugins/CCST/keep.txt`, 'user data');
        run(); // second run: no new backup, nothing deleted
        assert.equal(readdirSync(st).filter((f) => f.startsWith('config.yaml.ccst-backup-')).length, 1);
        assert.equal(readFileSync(`${st}/plugins/CCST/keep.txt`, 'utf8'), 'user data');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CCST_BRANCH: Mac installer clones that branch; both installers build the zip URL from it', (t) => {
    try { execFileSync('zsh', ['-c', 'exit 0']); execFileSync('git', ['--version']); } catch { return t.skip('needs zsh + git'); }
    const mac = readFileSync(`${dir}CCST安装.command`, 'utf8');
    const ps = readFileSync(`${dir}ccst-install.ps1`, 'utf8');
    assert.match(mac, /archive\/refs\/heads\/\$\{BRANCH:-main\}\.zip/);
    assert.match(ps, /archive\/refs\/heads\/\$ZipBranch\.zip/);
    assert.match(ps, /git clone --quiet --branch \$Branch/);
    const root = mkdtempSync(`${tmpdir()}/ccst-br-`);
    try {
        const st = `${root}/home/SillyTavern`;
        mkdirSync(`${st}/default`, { recursive: true });
        writeFileSync(`${st}/server.js`, ''); writeFileSync(`${st}/package.json`, '{ "name": "sillytavern" }');
        writeFileSync(`${st}/config.yaml`, 'enableServerPlugins: true\n');
        const repo = `${root}/repo`; mkdirSync(repo);
        const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
        const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { env: cleanEnv });
        git('init', '-q', '-b', 'main');
        writeFileSync(`${repo}/package.json`, '{ "name": "fake-ccst", "version": "main" }');
        git('add', '.'); git('commit', '-q', '-m', 'x');
        git('checkout', '-q', '-b', 'feature');
        writeFileSync(`${repo}/package.json`, '{ "name": "fake-ccst", "version": "feature" }');
        git('commit', '-q', '-am', 'y'); git('checkout', '-q', 'main');
        const env = { PATH: process.env.PATH, HOME: `${root}/home`, CCST_NO_PROCESS_SCAN: '1', CCST_SKIP_LOGIN: '1', CCST_YES: '1', CCST_REPO_URL: repo, CCST_BRANCH: 'feature' };
        execFileSync('zsh', [`${dir}CCST安装.command`], { env, encoding: 'utf8' });
        assert.match(readFileSync(`${st}/plugins/CCST/package.json`, 'utf8'), /"feature"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
