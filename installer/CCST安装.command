#!/bin/zsh
# CCST 一键安装（Mac，原版酒馆）：双击运行，或在终端用 install-plugin-mac.sh 一行运行，跟着提示做。可以重复运行（相当于更新）。
# 做的事：找到酒馆文件夹 -> 检查 Node.js -> 打开酒馆的「插件开关」（先备份）-> 装 CCST -> 装依赖 -> 登录 Claude。
# 不会删除你的任何数据。
# 测试用环境变量（平时不用）：CCST_ST_DIR 指定酒馆文件夹；CCST_NO_PROCESS_SCAN=1 不去找正在运行的酒馆；
#   CCST_SKIP_LOGIN=1 跳过登录；CCST_YES=1 不问问题；CCST_REPO_URL / CCST_ZIP_URL 换下载地址；
#   CCST_BRANCH 指定分支（默认用仓库默认分支）；CCST_FROM_TERMINAL=1 由终端一行安装调用（不等回车、提示改成「再运行一次那一行」）。

setopt NO_NOMATCH
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
REPO_URL="${CCST_REPO_URL:-https://github.com/kcgoofee-jpg/CCST}"
BRANCH="${CCST_BRANCH:-}"
ZIP_URL="${CCST_ZIP_URL:-https://github.com/kcgoofee-jpg/CCST/archive/refs/heads/${BRANCH:-main}.zip}"
ASSUME_YES="${CCST_YES:-0}"
FROM_TERMINAL="${CCST_FROM_TERMINAL:-0}"
if [[ "$FROM_TERMINAL" == 1 ]]; then AGAIN_FILE="再运行一次安装那一行"; else AGAIN_FILE="再双击一次本文件"; fi
STAMP=$(date +%Y%m%d-%H%M%S)

say()  { print -r -- "$*"; }
ok()   { print -r -- "  ✓ $*"; }
warn() { print -r -- "  ! $*"; }
step() { print -r -- ""; print -r -- "【$1】"; }
finish() { # $1=退出码
    print -r -- ""
    if [[ "$ASSUME_YES" != 1 && "$FROM_TERMINAL" != 1 ]]; then print -n -- "按回车键关闭这个窗口。"; read -r _ </dev/tty 2>/dev/null; fi
    exit ${1:-0}
}
stop_with() { # 出错：说清楚发生了什么、下一步做什么
    print -r -- ""
    print -r -- "✗ $1"
    shift
    local l; for l in "$@"; do print -r -- "  $l"; done
    [[ -n "$LOG" ]] && print -r -- "  还不行就把「${LOG:t}」（在${LOG:h:t}）发给作者。"
    finish 1
}
ask() { # $1=提示；返回输入的一行（去掉首尾空白）
    local a
    print -n -- "$1" >&2
    read -r a </dev/tty 2>/dev/null || a=""
    a=${a##[[:space:]]#}; a=${a%%[[:space:]]#}
    print -r -- "$a"
}

# 日志：屏幕上的每一行同时写进桌面的「CCST安装日志.txt」（每次覆盖），出问题时发这个文件
LOG="${HOME}/Desktop/CCST安装日志.txt"; [[ -d "${HOME}/Desktop" ]] || LOG="${HOME}/CCST安装日志.txt"
if : > "$LOG" 2>/dev/null; then
    print -r -- "$(date '+%F %T')  macOS $(sw_vers -productVersion 2>/dev/null)  $(uname -m)" >> "$LOG"
    exec > >(tee -a "$LOG") 2>&1
else LOG=""; fi
print -r -- "════════ CCST 一键安装 ════════"
say "这个程序会帮你把 CCST 装进酒馆。中间可能要等几分钟，请不要关窗口。"

# ── 1. 找酒馆文件夹 ──
is_st() { [[ -d "$1" && -f "$1/server.js" && -f "$1/package.json" ]] && grep -qi '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }
has_ext() { # 面板是不是装在这个酒馆里
    local d="$1" x
    [[ -d "$d/public/scripts/extensions/third-party/CCST" ]] && return 0
    for x in "$d"/data/*/extensions/CCST(N); do [[ -d "$x" ]] && return 0; done
    return 1
}
typeset -a found
add() { local d="${1:A}"; is_st "$d" || return; (( ${found[(Ie)$d]} )) || found+=("$d"); }
normalize_input() { # 拖进来的路径：去引号、还原空格转义、~
    local p="$1"
    p=${p#\'}; p=${p%\'}; p=${p#\"}; p=${p%\"}
    p=${(Q)p}
    p=${p%%[[:space:]]#}
    [[ "$p" == "~"* ]] && p="$HOME${p#\~}"
    print -r -- "$p"
}

step "1/6 找到酒馆（SillyTavern）文件夹"
ST=""
if [[ -n "${CCST_ST_DIR:-}" ]]; then
    is_st "$CCST_ST_DIR" && ST="${CCST_ST_DIR:A}" || stop_with "指定的文件夹不是酒馆：$CCST_ST_DIR" "请确认它里面有 server.js 和 package.json。"
else
    if [[ "${CCST_NO_PROCESS_SCAN:-0}" != 1 ]]; then # 正在运行的酒馆：看谁在监听端口，它的工作目录就是酒馆文件夹
        for pid in ${(u)${(f)"$(lsof -nP -iTCP -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p')"}}; do
            add "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
        done
    fi
    for c in "$HOME/SillyTavern" "$HOME/Desktop/SillyTavern" "$HOME/Documents/SillyTavern" "$HOME/Downloads/SillyTavern" "$HOME"/Downloads/*/SillyTavern(N) "$HOME"/Desktop/*/SillyTavern(N) "$HOME"/*/SillyTavern(N) "$HOME"/SillyTavern*(N/); do add "$c"; done
    # 装好面板的优先
    typeset -a with_ext
    for d in $found; do has_ext "$d" && with_ext+=("$d"); done
    (( ${#with_ext} >= 1 && ${#with_ext} < ${#found} )) && found=("${with_ext[@]}")
    if (( ${#found} == 1 )); then
        ST="$found[1]"
    elif (( ${#found} > 1 )); then
        say "找到了不止一个酒馆："
        i=1; for d in $found; do say "  $i) $d"; (( i++ )); done
        [[ "$ASSUME_YES" == 1 ]] && stop_with "找到不止一个酒馆，没法自动选。" "用 CCST_ST_DIR 指定其中一个。"
        while [[ -z "$ST" ]]; do
            a=$(ask "输入数字选一个；或者把要用的酒馆文件夹拖进这个窗口，再按回车：")
            if [[ "$a" == <-> ]] && (( a >= 1 && a <= ${#found} )); then ST="$found[a]"
            else p=$(normalize_input "$a"); if is_st "$p"; then ST="${p:A}"; else warn "这个不是酒馆文件夹（里面要有 server.js）。再试一次。"; fi; fi
        done
    else
        say "没有自动找到酒馆。"
        [[ "$ASSUME_YES" == 1 ]] && stop_with "没有找到酒馆文件夹。" "用 CCST_ST_DIR 指定。"
        say "请把酒馆文件夹（里面有 server.js、start.sh 的那个）从 Finder 拖进这个窗口，再按回车。"
        while [[ -z "$ST" ]]; do
            a=$(ask "酒馆文件夹：")
            [[ -z "$a" ]] && { warn "没有输入。想放弃就直接关掉这个窗口。"; continue; }
            p=$(normalize_input "$a")
            if is_st "$p"; then ST="${p:A}"; else warn "这个不是酒馆文件夹（里面要有 server.js）。再试一次。"; fi
        done
    fi
fi
ok "酒馆在：$ST"
has_ext "$ST" || warn "酒馆里还没有 CCST 面板：下次启动酒馆时会自动装上，不用管。"

# 已经是最新版（插件和面板都没有新提交、依赖在）：酒馆开着也不用关
up_to_date() { # $1=git 文件夹
    [[ -d "$1/.git" ]] || return 1
    { [[ "$(command -v git)" != /usr/bin/git ]] || xcode-select -p >/dev/null 2>&1; } || return 1
    git -C "$1" fetch --quiet 2>/dev/null || return 1
    local up; up=$(git -C "$1" rev-parse '@{u}' 2>/dev/null || git -C "$1" rev-parse origin/HEAD 2>/dev/null || git -C "$1" rev-parse origin/main 2>/dev/null)
    [[ -n "$up" && "$(git -C "$1" rev-parse HEAD 2>/dev/null)" == "$up" ]]
}
CURRENT=0
if [[ -d "$ST/plugins/CCST/node_modules" ]] && up_to_date "$ST/plugins/CCST"; then
    CURRENT=1
    for d in "$ST"/public/scripts/extensions/third-party/CCST(N/) "$ST"/data/*/extensions/CCST(N/); do
        [[ -d "$d/.git" ]] && ! up_to_date "$d" && CURRENT=0
    done
fi

# 酒馆正在运行：要更新就先关掉（换插件文件、移走旧插件时它不能占着），装完再打开
ST_PORT=$(sed -nE 's/^port:[[:space:]]*([0-9]+).*/\1/p' "$ST/config.yaml" 2>/dev/null | head -1)
ST_RUNNING=0; STOPPED=0
if [[ "${CCST_NO_PROCESS_SCAN:-0}" != 1 ]]; then
    typeset -a st_pids
    for pid in ${(f)"$(lsof -nP -iTCP:${ST_PORT:-8000} -sTCP:LISTEN -t 2>/dev/null)"}; do
        [[ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" == "$ST" ]] && st_pids+=("$pid")
    done
    if (( ${#st_pids} )) && (( CURRENT )); then
        ST_RUNNING=1; ok "CCST 已经是最新版，酒馆不用关"
    elif (( ${#st_pids} )); then
        ST_RUNNING=1
        a=y; [[ "$ASSUME_YES" == 1 ]] || a=$(ask "有新版本，要先关掉酒馆（聊天记录都已保存），装完在新窗口里重新打开。现在关？[Y/n] ")
        if [[ "$a" == [nN]* ]]; then warn "没关。装完要自己关掉酒馆再打开。"
        else
            kill $st_pids 2>/dev/null
            for i in {1..20}; do kill -0 $st_pids 2>/dev/null || break; sleep 0.5; done
            ST_RUNNING=0; STOPPED=1; ok "酒馆已关掉"
        fi
    fi
fi

# ── 2. Node.js ──
step "2/6 检查 Node.js（代理靠它运行）"
if ! command -v node >/dev/null 2>&1; then
    open "https://nodejs.org/zh-cn/download" 2>/dev/null
    stop_with "这台电脑上没有 Node.js。" "刚才已经帮你打开了 Node.js 官网：下载「LTS」版本的 macOS 安装包，一路点「继续」装好。" "装好以后，${AGAIN_FILE}就行。"
fi
nv=$(node -v)
if (( ${${nv#v}%%.*} < 18 )); then
    open "https://nodejs.org/zh-cn/download" 2>/dev/null
    stop_with "Node.js 版本太旧（$nv），需要 18 或更高。" "刚才已经帮你打开了 Node.js 官网：下载「LTS」版本装上，${AGAIN_FILE}。"
fi
ok "Node.js $nv"

# ── 3. 打开插件开关 ──
step "3/6 打开酒馆的插件开关"
CFG="$ST/config.yaml"
if [[ ! -f "$CFG" ]]; then
    if [[ -f "$ST/default/config.yaml" ]]; then
        cp "$ST/default/config.yaml" "$CFG" || stop_with "没法创建 config.yaml" "请检查酒馆文件夹有没有写入权限。"
        ok "酒馆还没生成设置文件，已按默认内容建了一个"
    else
        stop_with "酒馆文件夹里没有 config.yaml。" "先把酒馆启动一次（让它自己生成），关掉，${AGAIN_FILE}。"
    fi
fi
if grep -Eq '^enableServerPlugins:[[:space:]]*true([[:space:]]|#|$)' "$CFG"; then
    ok "插件开关本来就是开的"
else
    cp -p "$CFG" "$CFG.ccst-backup-$STAMP" || stop_with "备份 config.yaml 失败，没有改动任何东西。" "请检查酒馆文件夹有没有写入权限。"
    if grep -Eq '^enableServerPlugins:' "$CFG"; then
        sed -E 's/^enableServerPlugins:[[:space:]]*[A-Za-z]+/enableServerPlugins: true/' "$CFG" > "$CFG.tmp.$$" && cat "$CFG.tmp.$$" > "$CFG"; rm -f "$CFG.tmp.$$"
    else
        [[ -n "$(tail -c1 "$CFG")" ]] && print >> "$CFG"
        print -r -- "enableServerPlugins: true" >> "$CFG"
    fi
    grep -Eq '^enableServerPlugins:[[:space:]]*true' "$CFG" || stop_with "改设置文件没成功。" "备份在 $CFG.ccst-backup-$STAMP ，原文件没有损坏。" "手动改：用文本编辑打开 config.yaml，把 enableServerPlugins 那一行改成 true。"
    ok "已打开（只改了这一行，原文件备份在 config.yaml.ccst-backup-$STAMP）"
fi

# ── 4. 装 CCST ──
step "4/6 下载并安装 CCST"
DEST="$ST/plugins/CCST"
mkdir -p "$ST/plugins" || stop_with "没法创建 plugins 文件夹。" "请检查酒馆文件夹有没有写入权限。"
have_git=0
if command -v git >/dev/null 2>&1; then
    # 没装命令行工具的 Mac 上，运行 git 会弹出安装窗口：先确认它真的能用
    if [[ "$(command -v git)" != /usr/bin/git ]] || xcode-select -p >/dev/null 2>&1; then have_git=1; fi
fi
zip_install() {
    local tmp; tmp=$(mktemp -d) || return 1
    say "  正在下载…"
    curl -fL --retry 2 -o "$tmp/ccst.zip" "$ZIP_URL" || { rm -rf "$tmp"; return 1; }
    # ditto 认 UTF-8 文件名；unzip 在非 UTF-8 的区域设置下会把中文文件名变成问号并反复问「覆盖吗」
    { ditto -x -k "$tmp/ccst.zip" "$tmp/x" 2>/dev/null || unzip -q -o "$tmp/ccst.zip" -d "$tmp/x"; } || { rm -rf "$tmp"; return 1; }
    local top=("$tmp"/x/*(/N[1]))
    [[ -n "$top" && -f "$top/package.json" ]] || { rm -rf "$tmp"; return 1; }
    mkdir -p "$DEST" || { rm -rf "$tmp"; return 1; }
    # 更新：先清掉旧代码（新版删掉的文件不能留着），只留 data（聊天统计、设置）和 node_modules
    local x; for x in "$DEST"/*(DN); do [[ "${x:t}" == (data|node_modules) ]] || rm -rf "$x"; done
    cp -R "$top/." "$DEST/"; local rc=$?
    rm -rf "$tmp"; return $rc
}
if [[ -d "$DEST/.git" ]]; then
    say "  已经装过，检查更新…"
    if (( have_git )) && git -C "$DEST" pull --ff-only --quiet; then ok "已更新到最新"
    else warn "没能自动更新（可能你改过里面的文件，或者没联网）。继续使用现在这个版本。"; fi
elif [[ -f "$DEST/package.json" ]]; then
    say "  已经装过（下载版），更新文件…"
    zip_install && ok "已更新到最新" || warn "没能更新（没联网？）。继续使用现在这个版本。"
elif [[ -e "$DEST" && -n "$(/bin/ls -A "$DEST" 2>/dev/null)" ]]; then
    stop_with "plugins/CCST 已经存在，但里面不像是 CCST。" "为了不弄坏你的东西，没有动它。把它改个名字（比如 CCST-旧）${AGAIN_FILE}。"
else
    installed=0
    if (( have_git )); then
        say "  正在下载…"
        git clone --quiet ${BRANCH:+--branch} ${BRANCH:+"$BRANCH"} "$REPO_URL" "$DEST" && installed=1 || { warn "用 git 下载失败，换个办法再试"; rm -rf "$DEST" 2>/dev/null; }
    fi
    (( installed )) || zip_install && installed=1
    (( installed )) || stop_with "下载 CCST 失败。" "多半是没联网，或者访问 GitHub 很慢。检查网络（需要能打开 github.com），然后${AGAIN_FILE}。"
    ok "已下载到 $DEST"
fi
[[ -f "$DEST/package.json" ]] || stop_with "CCST 没装完整（缺少 package.json）。" "${AGAIN_FILE}试试。"

# 面板：在酒馆里「安装扩展」装的是 git 版，酒馆不会自己更新它
for d in "$ST"/public/scripts/extensions/third-party/CCST(N/) "$ST"/data/*/extensions/CCST(N/); do
    [[ -d "$d/.git" ]] || continue
    if (( have_git )) && git -C "$d" pull --ff-only --quiet; then ok "面板已更新"
    else warn "面板没能自动更新：在酒馆 扩展 → 管理扩展 里点 CCST 的「更新」。"; fi
done
# 旧版本留下的东西：别的文件夹里的旧插件 / 旧面板（会抢 8901 端口，聊天还是走旧代码）、旧版 Mac 启动器的开机自启
typeset -a old
for d in "$ST"/plugins/*(N/); do
    [[ "${d:t}" == CCST ]] && continue
    grep -qs "claude-subscription" "$d/package.json" "$d"/*.js(N) "$d/src/proxy/plugin.js" && old+=("$d")
done
old+=("$ST"/public/scripts/extensions/third-party/(SillyTavern-ClaudeMax|SillyTavern-ClaudeSubscription)(N/) "$ST"/data/*/extensions/(SillyTavern-ClaudeMax|SillyTavern-ClaudeSubscription)(N/) "$HOME"/Library/LaunchAgents/com.claudemax.*.plist(N))
if (( ${#old} )); then
    say "  找到旧版本留下的东西："
    for d in $old; do say "    $d"; done
    a=y; [[ "$ASSUME_YES" == 1 ]] || a=$(ask "  移到备份文件夹（不删除）？[Y/n] ")
    if [[ "$a" == [nN]* ]]; then warn "没动它们。它们还在的话，聊天可能还是走旧版本。"
    else
        BAK="$ST/CCST旧版备份-$STAMP"; mkdir -p "$BAK"
        for d in $old; do
            [[ "$d" == *.plist ]] && launchctl bootout "gui/$(id -u)" "$d" 2>/dev/null
            mv "$d" "$BAK/${d:h:t}-${d:t}" && ok "已移走 ${d:t}"
        done
        ok "备份在 $BAK（用了几天没问题就可以删）"
    fi
fi
# 正在运行的代理不是这一份（旧版本、别的文件夹）：装完要先关掉它
[[ "${CCST_NO_PROCESS_SCAN:-0}" == 1 ]] || running=$(curl -fsS -m 3 http://127.0.0.1:8901/status 2>/dev/null)
if [[ "$running" == *claude-subscription* ]]; then
    rv=${${running#*\"version\":\"}%%\"*}
    rroot=""; [[ "$running" == *'"root":"'* ]] && rroot=${${running#*\"root\":\"}%%\"*}
    [[ "$rroot" != "$DEST" ]] && warn "现在 8901 上在跑 CCST v${rv}${rroot:+（$rroot）}。下面装完后，先关掉所有酒馆窗口，再启动酒馆。"
fi

# ── 5. 依赖 ──
step "5/6 安装依赖（第一次要联网下载，约 1–3 分钟）"
if (cd "$DEST" && npm install --no-audit --no-fund --loglevel=error); then
    ok "依赖装好了"
else
    stop_with "依赖没装成功。" "先检查网络能不能上外网，${AGAIN_FILE}重试。" "如果窗口里提示 EACCES / 权限，把酒馆文件夹放到「文稿」或「桌面」里再试。"
fi

# 面板在酒馆里被停用了（扩展 → 管理扩展 里关掉的）：重新启用。酒馆开着时它会覆盖设置，只能让你自己开
if [[ -n "$(node "$DEST/installer/panel-enable.mjs" "$ST" --check 2>/dev/null)" ]]; then
    if (( ST_RUNNING )); then warn "CCST 面板在酒馆里被停用了：在 扩展 → 管理扩展 里把 CCST 打开。"
    else node "$DEST/installer/panel-enable.mjs" "$ST" >/dev/null 2>&1 && ok "CCST 面板之前被停用了，已重新启用"; fi
fi
# ── 6. 登录 Claude ──
step "6/6 登录 Claude"
if [[ "${CCST_SKIP_LOGIN:-0}" == 1 ]]; then
    warn "（测试：跳过登录）"
else
    if [[ "$(cd "$DEST" && node bin/claude-cli.js auth status 2>/dev/null)" =~ '"loggedIn"[[:space:]]*:[[:space:]]*true' ]]; then
        ok "已经登录过 Claude，不用再登了"
    else
        say "马上会打开浏览器，用你的 Claude 账号（Pro 或 Max）登录并点「授权」。"
        if (cd "$DEST" && npm run login --silent); then ok "登录成功"
        else
            warn "登录没完成，不影响安装。之后补登："
            say "  打开「终端」，输入 cd 后面加一个空格，把 $DEST 这个文件夹拖进去，回车，再输入 npm run login"
            say "  或者${AGAIN_FILE}，它会重新打开登录。"
        fi
    fi
fi

print -r -- ""
print -r -- "════════════════════════════════"
if (( STOPPED )) && open -a Terminal "$ST/start.sh" 2>/dev/null; then
    print -r -- "装好了。酒馆已经在新弹出的终端窗口里运行："
    print -r -- "  · 那个窗口就是酒馆，聊天时一直开着，关掉它酒馆和 CCST 就都停了。"
    print -r -- "  · 现在这个窗口可以关了。"
    print -r -- "  · 浏览器里按 Cmd+Shift+R 刷新酒馆页面。"
elif (( CURRENT && ST_RUNNING )); then
    print -r -- "已经是最新版，酒馆照常用，不用重启。"
else
    print -r -- "装好了。关掉酒馆再打开，面板会自动连上。"
    print -r -- "（酒馆是在终端窗口里运行的话，关掉那个窗口再重新启动；浏览器里按 Cmd+Shift+R 刷新一下。）"
fi
finish 0
