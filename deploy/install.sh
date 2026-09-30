#!/bin/sh
# CCST 云端 / Linux 服务器安装脚本（POSIX sh，可重复运行）
#
#   curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/deploy/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --public       # 监听所有网卡（必须带访问密码）
#   sh deploy/install.sh --uninstall                    # 卸载
#
# 做的事：检查 Node >= 18 和 git -> 下载 / 更新 CCST -> npm install ->
#         生成访问密码（0600）-> 用 systemd --user 启动代理（没有 systemd 就用 nohup）。
# 不会：改系统设置、需要 root、把访问密码以外的任何密钥打印出来。
#
# 选项：
#   --dir DIR        安装目录（默认：找到 SillyTavern 就装在它旁边，否则 ~/CCST；路径不能有空格）
#   --port N         代理端口（默认 8901）
#   --public         监听 0.0.0.0（默认只监听 127.0.0.1）
#   --local          改回只监听 127.0.0.1
#   --branch NAME    要装的分支或标签（默认仓库默认分支）
#   --skip-install   不跑 npm install（测试用）
#   --token-from-env 把环境变量 CLAUDE_CODE_OAUTH_TOKEN（在有浏览器的电脑上 claude setup-token 得到）存进配置，服务器不用再登录
#   --token-prompt   同上，但运行时从终端输入令牌（不回显；curl | sh 也能用）
#   --no-service     只安装文件，不启动代理
#   --dry-run        只打印会做什么，不改任何东西
#   --uninstall      停止并删除服务和配置（登录信息 ~/.claude 不动）
#   --remove-files   配合 --uninstall：同时删除安装目录（连同其中的 data/）
# 环境变量：CCST_REPO 覆盖仓库地址（测试用）。

set -eu

REPO="${CCST_REPO:-https://github.com/kcgoofee-jpg/CCST}"
CONF_DIR="$HOME/.config/ccst"
ENV_FILE="$CONF_DIR/env"
PID_FILE="$CONF_DIR/proxy.pid"
LOG_FILE="$CONF_DIR/proxy.log"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/ccst-proxy.service"
UNIT_NAME="ccst-proxy.service"

DIR=""; PORT=""; BIND=""; BRANCH=""
TOKEN_MODE=""; SKIP_INSTALL=0; NO_SERVICE=0; DRY=0; UNINSTALL=0; REMOVE_FILES=0

say()  { printf '%s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die()  { printf '错误：%s\n' "$*" >&2; exit 1; }
# 干跑时只打印命令，不执行
run()  { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) [ $# -ge 2 ] || die "--dir 需要一个路径"; DIR="$2"; shift ;;
        --port) [ $# -ge 2 ] || die "--port 需要一个数字"; PORT="$2"; shift ;;
        --branch) [ $# -ge 2 ] || die "--branch 需要一个名字"; BRANCH="$2"; shift ;;
        --public) BIND="0.0.0.0" ;;
        --local) BIND="127.0.0.1" ;;
        --token-from-env) TOKEN_MODE="env" ;;
        --token-prompt) TOKEN_MODE="prompt" ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --no-service) NO_SERVICE=1 ;;
        --dry-run) DRY=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --remove-files) REMOVE_FILES=1 ;;
        -h|--help) sed -n '2,26p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "不认识的选项：$1（--help 看用法）" ;;
    esac
    shift
done

case "$PORT" in *[!0-9]*) die "--port 必须是数字" ;; esac
case "$DIR" in *" "*) die "安装目录不能有空格：$DIR" ;; esac

# 读 env 文件里的一项（不 source，避免执行任何东西）
env_get() { if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; fi; }

have_systemd_user() {
    command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

pid_alive_ours() {
    [ -f "$PID_FILE" ] || return 1
    p=$(cat "$PID_FILE" 2>/dev/null || true)
    case "$p" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$p" 2>/dev/null || return 1
    # 只认 node 进程，pid 被别的程序复用时不误杀
    ps -p "$p" -o comm= 2>/dev/null | grep -q node
}

stop_nohup() {
    if pid_alive_ours; then
        p=$(cat "$PID_FILE")
        run kill "$p"
        if [ "$DRY" != 1 ]; then
            i=0
            while kill -0 "$p" 2>/dev/null && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
        fi
    fi
    run rm -f "$PID_FILE"
}

# ───────── 卸载 ─────────
if [ "$UNINSTALL" = 1 ]; then
    OLD_DIR=$(env_get CCST_DIR)
    say "卸载 CCST 代理服务…"
    if have_systemd_user && [ -f "$UNIT_FILE" ]; then
        run systemctl --user disable --now "$UNIT_NAME" || true
        run rm -f "$UNIT_FILE"
        run systemctl --user daemon-reload || true
    fi
    stop_nohup
    run rm -f "$ENV_FILE" "$LOG_FILE"
    run rmdir "$CONF_DIR" 2>/dev/null || true
    if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ]; then
        if [ "$REMOVE_FILES" = 1 ]; then
            # 只删确认是 CCST 的目录
            if [ -f "$OLD_DIR/server.js" ] && grep -q '"sillytavern-claude-max"' "$OLD_DIR/package.json" 2>/dev/null; then
                run rm -rf "$OLD_DIR"
            else
                warn "$OLD_DIR 看起来不是 CCST 目录，没删。"
            fi
        else
            say "安装目录 $OLD_DIR 保留着（含 data/ 里的后端设置和统计）。要连它一起删：再运行一次卸载并加 --remove-files（先别删配置的话得重装），或自己删。"
        fi
    fi
    say "完成。Claude 登录信息（~/.claude）没有动；要退出登录：cd 安装目录 && node bin/claude-cli.js auth logout"
    exit 0
fi

# ───────── 前置检查 ─────────
[ "$(uname -s)" = "Linux" ] || warn "这个脚本面向 Linux 服务器；当前系统是 $(uname -s)，继续但没有测过。"
command -v node >/dev/null 2>&1 || die "没找到 Node.js。请先安装 Node 18 或更新的 LTS（https://nodejs.org 或 nvm），再重新运行。"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 版本太旧（$(node -v)），需要 18 或更新。"
command -v npm >/dev/null 2>&1 || die "没找到 npm（通常随 Node 一起装）。"
command -v git >/dev/null 2>&1 || die "没找到 git。请先安装（例如 apt install git / dnf install git）。"
NODE_BIN=$(command -v node)

# ───────── 找酒馆、定安装目录 ─────────
ST_DIR=""
for c in "$HOME/SillyTavern" "$HOME"/*/SillyTavern "$PWD/SillyTavern" "$PWD/../SillyTavern"; do
    if [ -f "$c/server.js" ] && [ -f "$c/package.json" ] && grep -qi '"name": *"sillytavern"' "$c/package.json" 2>/dev/null; then
        ST_DIR=$(cd "$c" && pwd); break
    fi
done
if [ -z "$DIR" ]; then
    DIR=$(env_get CCST_DIR)
    if [ -z "$DIR" ]; then
        if [ -n "$ST_DIR" ]; then DIR="$(dirname "$ST_DIR")/CCST"; else DIR="$HOME/CCST"; fi
    fi
fi
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
case "$DIR" in *" "*) die "安装目录不能有空格：$DIR" ;; esac

# 端口和监听地址：命令行 > 上次的设置 > 默认
[ -n "$PORT" ] || PORT=$(env_get CLAUDE_SUBSCRIPTION_PORT)
[ -n "$PORT" ] || PORT=8901
[ -n "$BIND" ] || BIND=$(env_get CLAUDE_SUBSCRIPTION_HOST)
[ -n "$BIND" ] || BIND=127.0.0.1

say "CCST 安装：目录 $DIR，端口 $PORT，监听 $BIND，Node $(node -v)"
[ -z "$ST_DIR" ] || say "找到同一台服务器上的 SillyTavern：$ST_DIR"

# ───────── 下载 / 更新 ─────────
if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
    say "已有安装，更新中…"
    if [ -n "$BRANCH" ]; then
        run git -C "$DIR" fetch --quiet origin "$BRANCH"
        run git -C "$DIR" checkout --quiet "$BRANCH"
    fi
    run git -C "$DIR" pull --ff-only --quiet || warn "更新失败（本地有改动？），继续用现有版本。"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR 已存在且不是 CCST 的 git 仓库。换个目录（--dir）或先清理它。"
else
    say "下载 CCST 到 $DIR …"
    if [ -n "$BRANCH" ]; then run git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"; else run git clone --quiet "$REPO" "$DIR"; fi
fi

if [ "$SKIP_INSTALL" = 1 ]; then
    say "跳过 npm install（--skip-install）"
else
    say "安装依赖（npm install，不要加 --omit=optional：Claude CLI 在可选依赖里）…"
    if [ "$DRY" = 1 ]; then say "[dry-run] (cd $DIR && npm install --no-audit --no-fund)"; else (cd "$DIR" && npm install --no-audit --no-fund --loglevel=error); fi
fi

# ───────── 订阅令牌（可选，永远不打印）─────────
OAUTH_TOKEN=""
if [ "$TOKEN_MODE" = env ]; then
    OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
    [ -n "$OAUTH_TOKEN" ] || die "--token-from-env：环境变量 CLAUDE_CODE_OAUTH_TOKEN 是空的。先 export 它（值来自有浏览器的电脑上运行 claude setup-token）。"
elif [ "$TOKEN_MODE" = prompt ]; then
    [ "$DRY" = 1 ] || [ -r /dev/tty ] || die "--token-prompt 需要终端（读不到 /dev/tty）。无人值守请改用 --token-from-env。"
    if [ "$DRY" != 1 ]; then
        printf '粘贴 claude setup-token 得到的令牌（输入不显示）：' >/dev/tty
        stty -echo </dev/tty 2>/dev/null || true
        IFS= read -r OAUTH_TOKEN </dev/tty || true
        stty echo </dev/tty 2>/dev/null || true
        printf '\n' >/dev/tty
    fi
fi
if [ -n "$OAUTH_TOKEN" ]; then
    case "$OAUTH_TOKEN" in
        *[!A-Za-z0-9._~+/=-]*) die "令牌里有不该出现的字符（空格、引号等）。请只粘贴令牌本身。" ;;
    esac
    case "$OAUTH_TOKEN" in sk-ant-*) ;; *) warn "令牌不是 sk-ant- 开头，确认它来自 claude setup-token。" ;; esac
elif [ "$TOKEN_MODE" = prompt ] && [ "$DRY" != 1 ]; then
    die "没有输入令牌。"
fi

# ───────── 配置文件与访问密码 ─────────
NEW_KEY=""
KEY=$(env_get CLAUDE_SUBSCRIPTION_LAN_KEY)
if [ -z "$KEY" ]; then
    KEY=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
    [ "${#KEY}" -eq 48 ] || die "生成访问密码失败（读不了 /dev/urandom）。"
    NEW_KEY=$KEY
fi
if [ "$DRY" = 1 ]; then
    say "[dry-run] 写 $ENV_FILE（权限 0600：CCST_DIR、CLAUDE_SUBSCRIPTION_HOST/PORT/LAN_KEY；你手加的其他行原样保留）"
else
    umask 077
    mkdir -p "$CONF_DIR"
    chmod 700 "$CONF_DIR"
    TMP="$ENV_FILE.tmp.$$"
    # 保留用户自己加的行（后端密钥等），只重写我们管的四项
    if [ -f "$ENV_FILE" ]; then grep -v -E '^(CCST_DIR|CLAUDE_SUBSCRIPTION_HOST|CLAUDE_SUBSCRIPTION_PORT|CLAUDE_SUBSCRIPTION_LAN_KEY)=' "$ENV_FILE" > "$TMP" || true; else : > "$TMP"; fi
    if [ -n "$OAUTH_TOKEN" ]; then
        grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$TMP" > "$TMP.2" || true
        mv "$TMP.2" "$TMP"
    fi
    {
        if [ -n "$OAUTH_TOKEN" ]; then echo "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_TOKEN"; fi
        echo "CCST_DIR=$DIR"
        echo "CLAUDE_SUBSCRIPTION_HOST=$BIND"
        echo "CLAUDE_SUBSCRIPTION_PORT=$PORT"
        echo "CLAUDE_SUBSCRIPTION_LAN_KEY=$KEY"
    } >> "$TMP"
    chmod 600 "$TMP"
    mv "$TMP" "$ENV_FILE"
fi

# ───────── 启动 ─────────
MODE="none"
if [ "$NO_SERVICE" = 1 ]; then
    say "不启动服务（--no-service）。手动启动：cd $DIR && set -a && . $ENV_FILE && set +a && node server.js"
elif have_systemd_user; then
    MODE="systemd"
    if [ "$DRY" = 1 ]; then
        say "[dry-run] 写 $UNIT_FILE（ExecStart=$NODE_BIN server.js，EnvironmentFile=$ENV_FILE）"
        say "[dry-run] systemctl --user daemon-reload && systemctl --user enable $UNIT_NAME && systemctl --user restart $UNIT_NAME"
    else
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=CCST Claude proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
        stop_nohup
        systemctl --user daemon-reload
        systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
        systemctl --user restart "$UNIT_NAME"
    fi
else
    MODE="nohup"
    warn "没有可用的 systemd --user，改用 nohup 后台运行（服务器重启后需要重新运行本脚本）。"
    if [ "$DRY" = 1 ]; then
        say "[dry-run] nohup 启动 $NODE_BIN server.js，pid 写入 $PID_FILE，日志 $LOG_FILE"
    else
        stop_nohup
        (
            cd "$DIR"
            set -a
            # shellcheck disable=SC1090
            . "$ENV_FILE"
            set +a
            nohup "$NODE_BIN" server.js >>"$LOG_FILE" 2>&1 &
            echo $! > "$PID_FILE"
        )
    fi
fi

# ───────── 等它起来 ─────────
if [ "$DRY" != 1 ] && [ "$MODE" != "none" ]; then
    OK=0; i=0
    while [ $i -lt 20 ]; do
        if node -e "fetch('http://127.0.0.1:$PORT/status',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(j=>process.exit(j.plugin==='claude-subscription'?0:1),()=>process.exit(1))" 2>/dev/null; then OK=1; break; fi
        sleep 1; i=$((i + 1))
    done
    if [ "$OK" = 1 ]; then say "代理已启动：http://127.0.0.1:$PORT/v1"
    else
        warn "20 秒内没检测到代理响应。"
        if [ "$MODE" = systemd ]; then say "看日志：journalctl --user -u $UNIT_NAME -e"; else say "看日志：$LOG_FILE"; fi
    fi
fi

# ───────── 收尾说明 ─────────
say ""
say "──────── 接下来 ────────"
if [ -n "$OAUTH_TOKEN" ]; then
    say "1. Claude 订阅令牌已存进 $ENV_FILE（0600），不用再登录。令牌有效期约一年，到期在有浏览器的电脑上重新 claude setup-token 再运行本脚本。"
else
    say "1. 登录 Claude 订阅（服务器没有浏览器，二选一）："
    say "   A. 在有浏览器的电脑上运行 claude setup-token，得到令牌，然后在服务器上："
    say "        sh $DIR/deploy/install.sh --token-prompt      （粘贴令牌，不回显）"
    say "   B. cd $DIR && npm run login ：它打印网址，在你自己电脑的浏览器打开授权，把授权码粘贴回终端，存在 ~/.claude。"
fi
say "   不想用订阅、用 API 密钥 / Bedrock / Vertex / OpenRouter：把对应环境变量加到 $ENV_FILE，然后重启代理"
say "   （变量名和例子见 $DIR/docs/使用指南.md 的「服务器与 Docker」；也可以在面板「设置 → 代理后端」里填）。"
if [ -n "$ST_DIR" ]; then
    say "2. SillyTavern 就在这台服务器上（$ST_DIR）：也可以把 CCST 当酒馆插件装，不用另开代理："
    say "     在 config.yaml 设 enableServerPlugins: true，然后 cd $ST_DIR && node plugins.js install $REPO"
    say "   （插件方式由酒馆一起启动代理；它和本脚本装的独立代理二选一，别占同一个端口。）"
else
    say "2. 酒馆 / TauriTavern 的 Custom 端点填 http://<服务器地址>:$PORT/v1 ，API 密钥栏填下面的访问密码。"
    say "   默认只监听服务器本机；从自己电脑访问用 SSH 隧道：ssh -N -L $PORT:127.0.0.1:$PORT 用户@服务器"
fi
if [ "$BIND" = "0.0.0.0" ]; then
    say ""
    say "!!! 已监听 0.0.0.0（所有网卡）。拿到访问密码的人用的就是你的订阅，而且这个端口是明文 HTTP。"
    say "!!! 防火墙只放行你自己的 IP；最好前面加 HTTPS 反向代理。注意：同机反代过来的请求在代理看来是「本机」，"
    say "!!! 会绕过访问密码，反代自己必须做认证。不需要公网访问就别用 --public（用 SSH 隧道）。"
fi
if [ "$MODE" = systemd ]; then
    say ""
    say "想让服务在你退出登录后也一直运行：sudo loginctl enable-linger \$USER"
    say "管理：systemctl --user status|restart|stop $UNIT_NAME"
fi
say "卸载：sh $DIR/deploy/install.sh --uninstall"
say ""
if [ -n "$NEW_KEY" ]; then
    say "访问密码（只显示这一次，已存到 $ENV_FILE，权限 0600）："
    say "  $NEW_KEY"
else
    say "访问密码沿用上次的，在 $ENV_FILE 里（不再显示）。"
fi
