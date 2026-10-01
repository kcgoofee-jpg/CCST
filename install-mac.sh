#!/bin/zsh
# Mac 一行安装 / 更新：打开「终端」，粘贴这一行，回车：
#   zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-mac.sh)"
# 终端自己下载的文件不带「来自网络」标记，所以不会被系统拦住（双击下载的 .command 会被拦）。
# 装到 ~/CCST；再运行一次就是更新：覆盖代码，保留登录、连接码密码和数据。
# 测试用：CCST_ZIP=本地 zip 路径。
set -e
DEST="$HOME/CCST"
ZIP_URL="${CCST_ZIP:-https://github.com/kcgoofee-jpg/CCST/archive/refs/heads/main.zip}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
print "正在下载 CCST…"
if [[ -f "$ZIP_URL" ]]; then cp "$ZIP_URL" "$tmp/ccst.zip"
else curl -fL --progress-bar -o "$tmp/ccst.zip" "$ZIP_URL" || { print "下载失败：检查网络（GitHub 打不开时开代理再试）。"; exit 1; }
fi
ditto -x -k "$tmp/ccst.zip" "$tmp/x"
src=("$tmp"/x/*(/[1]))
mkdir -p "$DEST"
rsync -a "$src/" "$DEST/"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
print "已放到 $DEST"
exec /bin/zsh "$DEST/launcher/mac/首次安装.command"
