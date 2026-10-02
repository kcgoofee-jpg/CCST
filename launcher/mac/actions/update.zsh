#!/bin/zsh
# 检查更新：问 GitHub 最新的 Release，比现在新就下载覆盖代码，依赖有变就重装，然后问要不要重启代理。
# 不删任何东西：登录、聊天、data/、各种 .local 设置都留着。git clone 来的就 git pull。
source "${0:A:h}/../lib.zsh"
CCST_REPO="kcgoofee-jpg/CCST"

# 整个流程包在函数里：更新会覆盖本脚本自己，函数是整段读进内存再执行的，不会读到一半被换掉
update_main() {
    banner "检查更新"
    explain "问 GitHub 有没有新版本；有就下载、覆盖代码（登录、聊天记录和设置都保留），然后问你要不要重启代理。"

    local cur latest json
    cur=$(node -p "require('$PROXY_DIR/package.json').version" 2>/dev/null)
    step "1/3 问 GitHub 最新版本"
    json=$(curl -fsSL --max-time 15 -H 'User-Agent: ccst-launcher' "https://api.github.com/repos/$CCST_REPO/releases/latest") || {
        fail "没连上 GitHub"
        fix "检查网络（GitHub 打不开时开代理再试）。"
        summary; pause_end 1
    }
    latest=$(print -r -- "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(String(JSON.parse(s).tag_name||"").replace(/^v/,""))}catch{console.log("")}})')
    if [[ ! "$latest" =~ '^[0-9]+\.[0-9]+\.[0-9]+' ]]; then
        fail "没读懂 GitHub 的回答（可能被限流了）"
        fix "过几分钟再试。"
        summary; pause_end 1
    fi
    rm -f "$PROXY_DIR/launcher/update-check.local.json"   # 让菜单首页的「有新版本」提醒重新问一次

    local again=0
    if [[ "$cur" == "$latest" ]]; then
        ok "已经是最新版 v$cur"
        ask_yes "还要重新下载覆盖一遍吗？（文件被改坏了才需要）" || { summary; pause_end 0; }
        again=1
    elif [[ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -n 1)" == "$cur" ]]; then
        ok "本地 v$cur 比最新发布的 v$latest 还新（开发版），不用更新"
        summary; pause_end 0
    else
        ok "有新版本：v$latest（现在 v$cur）"
    fi

    step "2/3 更新代码"
    local before after
    before=$(cat "$PROXY_DIR/package.json" "$PROXY_DIR/package-lock.json" 2>/dev/null | shasum)
    if [[ -d "$PROXY_DIR/.git" ]]; then
        explain "这个文件夹是 git 下载的：用 git pull。"
        if git -C "$PROXY_DIR" pull --ff-only --quiet; then ok "已更新"
        else
            fail "git pull 没成功（可能改过里面的文件）"
            fix "在这个文件夹里自己处理，或者把它移走后重新运行安装那一行。"
            summary; pause_end 1
        fi
    else
        local tmp zip src
        tmp=$(mktemp -d)
        explain "下载 v$latest …"
        zip="$tmp/ccst.zip"
        if ! curl -fL --progress-bar -o "$zip" "https://github.com/$CCST_REPO/archive/refs/tags/v$latest.zip"; then
            rm -rf "$tmp"
            fail "下载失败"
            fix "检查网络后再试。"
            summary; pause_end 1
        fi
        ditto -x -k "$zip" "$tmp/x" 2>/dev/null
        src=("$tmp"/x/*(/N[1]))
        if [[ -z "$src" || ! -f "$src/package.json" ]]; then
            rm -rf "$tmp"
            fail "下载的文件不完整"
            fix "再试一次；还不行就在终端重新运行安装那一行。"
            summary; pause_end 1
        fi
        # 只覆盖同名文件，从不删除：登录、data/、.local 设置都不在压缩包里，原样保留
        rsync -a "$src/" "$PROXY_DIR/" && ok "代码已覆盖到 v$latest" || { rm -rf "$tmp"; fail "复制文件失败"; summary; pause_end 1; }
        xattr -dr com.apple.quarantine "$PROXY_DIR" 2>/dev/null
        rm -rf "$tmp"
    fi

    step "3/3 依赖"
    after=$(cat "$PROXY_DIR/package.json" "$PROXY_DIR/package-lock.json" 2>/dev/null | shasum)
    if [[ "$before" != "$after" ]]; then
        reinstall_deps "$PROXY_DIR" "Claude 代理"
    else
        ok "依赖没变，不用重装"
    fi
    summary
    (( FAIL_COUNT > 0 )) && pause_end 1

    if [[ -n "$(our_pids $PROXY_PORT)" ]]; then
        warn "正在运行的代理还是旧代码，重启后才会用上新版"
        if ask_yes "现在重启代理吗？"; then
            exec /bin/zsh "$LAUNCHER_DIR/actions/restart.zsh"
        fi
        explain "之后想重启：菜单首页按 2。"
    else
        explain "代理没在运行，下次启动就是新版。"
    fi
    pause_end 0
}
update_main
