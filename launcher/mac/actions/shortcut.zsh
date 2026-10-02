#!/bin/zsh
# 桌面快捷方式：在桌面放一个「酒馆工具」，双击就打开菜单。丢了、被移动了都可以再点一次。
source "${0:A:h}/../lib.zsh"
banner "桌面快捷方式"
explain "在桌面放一个「酒馆工具.command」，双击就打开这个菜单。已经有就不动它。"
ensure_desktop_shortcut
summary
pause_end
