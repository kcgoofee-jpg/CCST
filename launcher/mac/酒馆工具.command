#!/bin/zsh
# CCST 酒馆工具（macOS）：启动壳。菜单本体是 launcher/menu.mjs（Mac / Windows / Termux 共用）。
HERE=${0:A:h}
[[ "$LANG" == *UTF-8* ]] || export LANG=zh_CN.UTF-8
# 从访达双击时 PATH 很短：补上常见的 Node 安装位置
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[[ -d "$HOME/.nvm/versions/node" ]] && export PATH="$(print -r -- $HOME/.nvm/versions/node/*/bin(N[-1])):$PATH"
if ! command -v node >/dev/null; then
    print "没有找到 Node.js：酒馆工具和代理都要用它。"
    print "到 https://nodejs.org 下载 LTS 版安装，或双击 launcher/mac/首次安装.command。"
    read -k 1 -s "?按任意键关闭…"
    exit 1
fi
# 窗口高度不够时二维码会被挤出屏幕：把终端窗口拉到 84×32（Terminal.app 认这个转义序列，别的终端忽略）
[[ -t 1 ]] && printf '\e[8;32;84t'
node "$HERE/../menu.mjs"
rc=$?
if (( rc != 0 )); then
    # 菜单自己出错了：窗口留着，让人看得到报错，不自动关
    print
    print "菜单异常退出（退出码 $rc）。把上面的内容发给帮你的人。"
    read -r "?按回车关闭…"
    exit $rc
fi
# 用户按 q 正常退出：关掉这个终端窗口
source "$HERE/lib.zsh" >/dev/null 2>&1 && close_terminal_window
