#!/bin/zsh
# 本地门控（dev 分支）：提交 / 推送前由 .githooks 调用，也可以手动跑。
#   zsh scripts/gate.sh          提交前：cargo test + 暂存区新增行的密钥扫描
#   zsh scripts/gate.sh --push   推送前：另外要求工作区干净
set -u
cd "${0:A:h}/.."
mode=commit; [[ "${1:-}" == --push ]] && mode=push
fail=0
say() { print -r -- "gate: $*"; }
bad() { print -r -- "gate: ✗ $*"; fail=1; }

if ! cargo test --quiet >/dev/null 2>&1; then bad "cargo test 没过（运行 cargo test 看详情）"; fi

added=$( [[ $mode == push ]] && git diff "@{u}..HEAD" 2>/dev/null || git diff --cached )
# 字符类写法避免扫到自己。
if print -r -- "$added" | grep -E '^\+' | grep -Eq 's[k]-ant-[A-Za-z0-9_-]{20,}|gh[p]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVAT[E] KEY'; then
    bad "新增内容里有像密钥 / 令牌的字符串"
fi
if [[ $mode == push && -n "$(git status --porcelain)" ]]; then bad "还有没提交的改动"; fi

if (( fail )); then say "没通过"; exit 1; fi
say "✓ 通过"
