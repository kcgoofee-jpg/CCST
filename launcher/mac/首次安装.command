#!/bin/zsh
# 首次安装（macOS）：一般由 install-mac.sh（终端一行安装）调用；git clone 的也可以直接运行，按提示一步步来。
#   ① Node.js  ② 程序依赖  ③ 登录 Claude  ④ 桌面放「酒馆工具」快捷方式  ⑤ 启动代理，打开 TauriTavern / 酒馆
# 不再逐项问 y/N（只有缺 Node 且有 Homebrew 时问一次）；做完直接进「酒馆工具」菜单，窗口不关。
# 可以重复运行：已经做好的步骤会跳过。
source "${0:A:h}/lib.zsh"
banner "首次安装"
explain "大约几分钟。中间会打开浏览器，让你用 Claude 账号登录一次。"

step "1/5 Node.js（代理靠它运行）"
if ! command -v node >/dev/null; then
    fail "没有找到 Node.js"
    if command -v brew >/dev/null && ask_yes "用 Homebrew 安装 Node.js 吗？（需要联网，几分钟）"; then
        brew install node || { fail "安装失败"; fix "到 https://nodejs.org 下载 LTS 安装包，装好后再双击本脚本。"; summary; pause_end 1; }
        (( FAIL_COUNT-- ))
    else
        fix "浏览器会打开 Node.js 官网：下载 LTS 版本的 macOS 安装包，装好后再双击本脚本。"
        open "https://nodejs.org/zh-cn/download"
        summary; pause_end 1
    fi
fi
nv=$(node -v)
if (( ${${nv#v}%%.*} < 18 )); then
    fail "Node.js 版本太旧：$nv（需要 18 或更高）"
    fix "到 https://nodejs.org 安装新版 LTS，再双击本脚本。"
    summary; pause_end 1
fi
ok "Node.js $nv"

step "2/5 程序依赖"
if [[ -d "$PROXY_DIR/node_modules" ]] && (cd "$PROXY_DIR" && node -e "require.resolve('@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch+'/package.json')" >/dev/null 2>&1); then
    ok "已经装好"
else
    explain "第一次要从网上下载，约 1–2 分钟。"
    reinstall_deps "$PROXY_DIR" "Claude 代理"
    (( FAIL_COUNT > 0 )) && { summary; pause_end 1; }
fi

step "3/5 登录 Claude 订阅（Pro / Max）"
if [[ "$(login_state)" == yes* ]]; then
    check_login
else
    explain "接下来会打开浏览器，用你的 Claude 账号授权，登录完回到这个窗口。只需要一次。"
    (cd "$PROXY_DIR" && node bin/claude-cli.js auth login)
    check_login
fi

step "4/5 桌面快捷方式"
shortcut="$HOME/Desktop/酒馆工具.command"
MARK="# 酒馆工具菜单（转到仓库里的脚本"
make_shortcut() {
    local t="$LAUNCHER_DIR/酒馆工具.command"
    print -r -- "#!/bin/zsh
$MARK，仓库更新后自动跟着更新）
t=${(q)t}
[[ -f \"\$t\" ]] || { print \"找不到酒馆工具：\$t\"; print \"CCST 文件夹被移动或删掉了。在「终端」里重新运行一次安装那一行，会重新放一个快捷方式。\"; read -k 1 -s 2>/dev/null; exit 1; }
exec /bin/zsh \"\$t\"" >"$shortcut" && chmod +x "$shortcut"
}
if [[ -f "$shortcut" ]] && grep -qF "$LAUNCHER_DIR/酒馆工具.command" "$shortcut"; then
    ok "桌面上已经有「酒馆工具」"
elif [[ -f "$shortcut" ]] && grep -qF "$MARK" "$shortcut"; then
    make_shortcut && ok "桌面上的「酒馆工具」指向旧位置，已经换成现在这个文件夹"
elif [[ -e "$shortcut" ]]; then
    warn "桌面上已经有一个别的「酒馆工具.command」，没有覆盖"
    explain "  菜单本体在：$LAUNCHER_DIR/酒馆工具.command"
else
    make_shortcut && ok "已放到桌面：酒馆工具（平时双击它就行）"
fi

step "5/5 启动"
start_proxy
have_tt=0; [[ -d /Applications/TauriTavern.app ]] && have_tt=1
target=""
if st_managed; then
    start_st && open "http://127.0.0.1:$ST_PORT"
    target="酒馆"
elif (( have_tt )); then
    mac_tt_open
    target="TauriTavern"
else
    warn "这台 Mac 上没找到 TauriTavern，也没找到酒馆（SillyTavern）"
    fix "推荐装 TauriTavern（桌面 App）：https://github.com/Darkatse/TauriTavern/releases ，装好后在菜单里按回车启动。"
    explain "  用原版酒馆的话，把本仓库放在酒馆目录旁边（和 SillyTavern 文件夹同级），或在 launcher/config.local 里写 ST_DIR=\"酒馆目录\"。"
fi
summary

# 接下来做什么：进菜单会清屏，所以先写在这里，看完按回车再进菜单（菜单首页也有「下一步」）
print
print -r -- "${C_BOLD}接下来：${C_RESET}"
if [[ "$target" == TauriTavern ]]; then
    print -r -- "  ① 在 TauriTavern 里：扩展 → 安装扩展，地址填 ${C_BOLD}https://github.com/kcgoofee-jpg/CCST${C_RESET}（第一次要装）"
    print -r -- "  ② 打开 CCST 面板，点「一键连接」"
elif [[ "$target" == 酒馆 ]]; then
    print -r -- "  ① 在酒馆里：打开 CCST 面板，点「一键连接」（面板没出现就强制刷新：Cmd+Shift+R）"
else
    print -r -- "  ① 装好 TauriTavern 后，回到菜单按回车启动"
fi
print -r -- "  想在手机上用：在菜单里按 ${C_BOLD}1${C_RESET}（手机），开启后扫二维码"
print
if [[ -t 0 ]]; then
    print -n -- "${C_BOLD}按回车进入「酒馆工具」菜单…${C_RESET}"
    read -r
    exec /bin/zsh "$LAUNCHER_DIR/酒馆工具.command"
fi
exit 0
