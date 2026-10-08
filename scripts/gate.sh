#!/bin/zsh
# 本地门控：提交 / 推送前自动跑（.githooks），也可以手动跑：
#   zsh scripts/gate.sh          检查暂存区（= 下一次提交的内容）
#   zsh scripts/gate.sh --push   检查还没推上去的提交（手动跑时按 @{u}..HEAD 算）
# 检查项：
#   1. 单元测试 —— 跑在「要提交的快照」上，不是工作区：
#      提交模式 = 暂存区（git checkout-index），推送模式 = HEAD（git archive）
#   2. 语法：所有 .js/.mjs/.cjs（node --check）、.sh（sh/bash -n）、.zsh/.command（zsh -n）、.py（ast 解析，不写 __pycache__）
#   3. 版本号：manifest.json 和 package.json 一致（scripts/version.mjs --check）
#   4. 密钥扫描：要提交 / 推送的「新增行」里不能有 API 密钥、令牌、私钥，
#      本机文件（*.local、data/、secrets.json）不能进提交
#   --push 时另外检查：工作区干净（没有漏提交的改动）
# 注意：本文件里的正则都用了字符类（如 github[_]pat_），这样扫描自己时不会误报。
# 审: 未定义变量即报错，防止脚本里变量名拼错后静默放行。
set -u
# 审: 下面的 **/*.(js|mjs|cjs)(N.) 等 zsh 通配符需要它。
setopt extendedglob
# 审: 切到仓库根目录，无论从哪里调用。
cd "${0:A:h}/.."
root=$PWD
# 审: 提交模式检查暂存区，--push 模式检查要推送的提交。
mode=commit; [[ "${1:-}" == --push ]] && mode=push
# 审: pre-push 钩子带参数调用时 from_hook=1，决定是否从 stdin 读 ref 列表。
# pre-push 钩子会把 <远端名> <地址> 跟在 --push 后面传进来，并在 stdin 里给出要推的 ref
from_hook=0; [[ $mode == push && -n "${2:-}" ]] && from_hook=1
# 审: 任一检查失败置 1，结尾据此退出。
fail=0
# 审: 带 gate: 前缀打印一行信息。
say()  { print -r -- "gate: $*"; }
# 审: 报一条失败并置 fail=1。
bad()  { print -r -- "gate: ✗ $*"; fail=1; }
# 审: 全零 sha = 远端不存在/删除，推送模式识别新分支用。
ZERO=0000000000000000000000000000000000000000

# 审: 提醒还没启用 .githooks 的人（只提示，不算失败）。
[[ "$(git config core.hooksPath)" == .githooks ]] || say "提示：还没启用自动门控，运行一次 git config core.hooksPath .githooks"

# 审: 临时快照目录，退出时清理；测试和语法检查都跑在快照上而不是工作区。
snap=$(mktemp -d "${TMPDIR:-/tmp}/cm-gate.XXXXXX") || { say "mktemp 失败"; exit 1; }
trap 'rm -rf -- "$snap"' EXIT INT TERM

# ---------- 0. 取快照 ----------
if [[ $mode == commit ]]; then
    git checkout-index -a --prefix="$snap/" || bad "暂存区导出失败"
else
    git archive HEAD | tar -x -C "$snap" || bad "HEAD 导出失败"
fi
# 审: 快照里没有 node_modules，用符号链接借用，否则测试跑不起来。
[[ -d node_modules && ! -e "$snap/node_modules" ]] && ln -s "$root/node_modules" "$snap/node_modules"

# ---------- 1. 单元测试（在快照里跑）----------
# 审: 测试输出日志；失败时 tail 给人看。
log=/tmp/cm-gate-test.log
if ! (cd "$snap" && npm test --silent) >"$log" 2>&1; then
    bad "单元测试失败（$log）"; tail -20 "$log"
fi

# ---------- 2. 语法（快照里只有被跟踪的文件；** 不跟进 node_modules 链接）----------
cd "$snap"
js=( **/*.(js|mjs|cjs)(N.) )
if (( ${#js} )); then
    print -rN -- $js | xargs -0 -P 8 -n 1 sh -c 'node --check "$1" 2>/dev/null || echo "$1"' _ >"$snap/.js-bad"
    for f in ${(f)"$(<"$snap/.js-bad")"}; do bad "JS 语法错误：$f"; done
fi
for f in **/*.sh(N.); do
    case "$(head -1 "$f")" in                  # 按 shebang 选解释器
        *zsh*)  zsh -n "$f"  2>/dev/null || bad "语法错误：$f" ;;
        *bash*) bash -n "$f" 2>/dev/null || bad "语法错误：$f" ;;
        *)      sh -n "$f"   2>/dev/null || bad "语法错误：$f" ;;
    esac
done
for f in **/*.(zsh|command)(N.); do
    zsh -n "$f" 2>/dev/null || bad "语法错误：$f"
done
py=( **/*.py(N.) )
if (( ${#py} )); then
    python3 - $py <<'EOF' | while IFS= read -r f; do bad "语法错误：$f"; done
import ast, sys
for f in sys.argv[1:]:
    try:
        ast.parse(open(f, 'rb').read(), f)
    except Exception:
        print(f)
EOF
fi

# ---------- 3. 版本号（快照里的文件）----------
# 版本号只写在 package.json（docs/版本规范.md），manifest.json 由 scripts/version.mjs 同步
node scripts/version.mjs --check || bad "版本号不一致（见上一行）"
cd "$root"

# ---------- 4. 密钥 / 本机文件：只看要提交 / 推送的内容 ----------
# names = 新增或改动的文件名；added = 新增行（去掉 +++ 文件头）
# 审: 关掉路径转义，中文文件名才能被后面的 grep 正常匹配。
G=(git -c core.quotepath=off)
if [[ $mode == commit ]]; then
    names=$($G diff --cached --name-only --diff-filter=ACMR)
    patch=$($G diff --cached --no-color --no-ext-diff)
else
    # pre-push 的 stdin：<本地 ref> <本地 sha> <远端 ref> <远端 sha>
    # 手动跑时自己按 @{u}..HEAD 造一行（没有上游就看所有不在任何远端分支上的提交）
    if (( ! from_hook )); then
        up=$(git rev-parse -q --verify '@{u}' 2>/dev/null) || up=$ZERO
        refs="HEAD $(git rev-parse HEAD) @{u} $up"
    else
        refs=$(cat)
    fi
    names= patch=
    while read -r lref lsha rref rsha; do
        [[ -n "${lsha:-}" && $lsha != $ZERO ]] || continue            # 删除远端分支：没有新内容
        if [[ $rsha != $ZERO ]] && git cat-file -e "$rsha^{commit}" 2>/dev/null; then
            excl=(--not "$rsha")                                       # 已有分支：只看新提交
        else
            excl=(--not --remotes)                                     # 新分支 / 远端提交本地没有
        fi
        names+=$($G log --format= --name-only --diff-filter=ACMR "$lsha" $excl)$'\n'
        patch+=$($G log --format= -p --no-color --no-ext-diff "$lsha" $excl)$'\n'
    done <<< "$refs"
fi
# 审: 只取新增行，已有内容不重复扫。
added=$(print -r -- "$patch" | grep -E '^\+' | grep -vE '^\+\+\+ ')

# 审: 密钥正则（Anthropic/OpenAI/GitHub/Google/AWS/Slack/JWT/私钥）；见开头说明为何用字符类。
PAT='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{24,}|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}'
PAT+='|gh[pousr]_[A-Za-z0-9]{20,}|github[_]pat_'
PAT+='|AIza[0-9A-Za-z_-]{30}|pst-[A-Za-z0-9]{20,}'
PAT+='|-----BEGIN [A-Z ]*PRIVATE KEY-----|BEGIN (RSA|OPENSSH) PRIVATE'
PAT+='|AKIA[0-9A-Z]{16}|xox[bpars]-[A-Za-z0-9-]{10,}'
PAT+='|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
print -r -- "$added" | grep -qE "$PAT" && { [[ $mode == commit ]] && bad "要提交的内容里像有密钥（git diff --cached 自己看看）" \
                                || bad "要推送的提交里像有密钥（git log -p @{u}..HEAD 自己看看）"; }

# 审: 本机文件（*.local、data/、secrets.json）不允许进提交。
print -r -- "$names" | grep -E '\.local(\.|$)|(^|/)data/|secrets\.json' && bad "本机文件被加进了提交"

# 审: 推送时工作区必须干净，避免漏提交的改动。
if [[ $mode == push ]]; then
    [[ -z "$(git status --porcelain)" ]] || bad "还有没提交的改动"
fi

(( fail )) && { say "没通过"; exit 1; }
say "✓ 通过"
