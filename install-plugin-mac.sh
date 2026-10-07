#!/bin/zsh
# Mac 一行安装（原版酒馆，装成酒馆服务器插件）：打开「终端」，粘贴这一行，回车：
#   zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"
# 做的事和双击版「CCST安装」一样（找酒馆文件夹、开插件开关、装 CCST、装依赖、登录），
# 但终端自己下载的文件不带「来自网络」标记，不会被 macOS 15 以上拦住。可以重复运行（相当于更新）。
# 测试用：CCST_INSTALLER=本地安装脚本路径（不下载）；其余环境变量见 installer/CCST安装.command。
set -e
BASE="${CCST_RAW_BASE:-https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ -n "${CCST_INSTALLER:-}" ]]; then cp "$CCST_INSTALLER" "$tmp/install.zsh"
else
    print "正在下载安装程序…"
    curl -fsSL -o "$tmp/install.zsh" "$BASE/installer/CCST%E5%AE%89%E8%A3%85.command" \
        || { print "下载失败：检查网络（GitHub 打不开时开代理再试）。"; exit 1; }
fi
set +e
CCST_FROM_TERMINAL=1 /bin/zsh "$tmp/install.zsh"
exit $?
