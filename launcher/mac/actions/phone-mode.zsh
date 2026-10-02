#!/bin/zsh
# 手机模式 / 电脑模式切换
#   手机模式：同一 Wi-Fi 下手机上的 TauriTavern 用这台 Mac 的代理（要访问密码）；
#             Mac 保持不睡眠，代理掉了自动重启，Mac 地址变了发通知（Mac 通知中心 + 已连接的手机）
#   电脑模式：代理只给这台 Mac 自己用，守护关闭，Mac 正常睡眠
source "${0:A:h}/../lib.zsh"
banner "手机模式 / 电脑模式"
# 菜单的「手机」页调用时带 CM_PHONE_ACTION=on|off：用户已经在菜单里确认过，这里不再问；不带就是原来的「看现状再问」
want=${CM_PHONE_ACTION:-}

# 让代理按新的模式重新监听：0 = 已按新模式在运行；1 = 代理在忙，这次没重启；2 = 启动失败
restart_proxy_if_idle() {
    if [[ -z "$(our_pids $PROXY_PORT)" ]]; then
        start_proxy || return 2
    elif proxy_busy; then
        return 1
    else
        stop_one $PROXY_PORT "Claude 代理"
        start_proxy || return 2
    fi
    return 0
}

show_phone_setup() {
    local ip=$(lan_ip)
    step "手机上的设置"
    if [[ -z "$ip" ]]; then
        warn "没找到这台 Mac 的局域网 IP：确认 Wi-Fi 已连接。"
    else
        # 地址 + 访问密码合成一串，手机上整串粘贴。只显示，不写进日志。格式见 src/panel/core/connect-code.js
        print -r -- "  ${C_GREEN}✓${C_RESET} 手机连接码：http://$ip:$PROXY_PORT/v1#k=$(<"$LAN_KEY_FILE")"
    fi
    explain "手机 TauriTavern → 扩展 → CCST：连不上代理时，顶部卡片里粘贴这串，点「连接」。"
    explain "以后在「酒馆工具」首页按 1（手机）随时能看到，按 c 复制。已经用「同步手机」同步过的话，手机上已经填好了。"
}

if [[ -s "$LAN_KEY_FILE" && "$want" == on ]]; then
    ok "手机模式已经开着"
    show_phone_setup
    summary; pause_end; exit 0
fi
if [[ ! -s "$LAN_KEY_FILE" && "$want" == off ]]; then
    ok "现在就是电脑模式"
    summary; pause_end; exit 0
fi
if [[ -s "$LAN_KEY_FILE" ]]; then
    step "现在是：手机模式"
    if watchdog_running; then
        ok "守护在运行：防睡眠、掉线自动重启、地址变化通知"
    else
        warn "守护没在运行，现在启动"
        if watchdog_start; then ok "守护已启动"; else fail "守护没有启动成功"; fix "看日志文件夹里的 watchdog.log。"; fi
    fi
    if lid_awake_on; then ok "合盖不睡：开着"
    elif lid_supported; then
        why=$(lid_release_reason); [[ "$why" == off ]] && why="config.local 里写了 LID_AWAKE=0"
        watchdog_running || why="守护没在运行"
        explain "合盖不睡：已安装，现在放开着（${why:-条件刚恢复}），条件恢复后守护会自动打开"
        explain "  （会放开的情况：电量低、低电量模式、合盖长时间没请求、手机上暂停了、LID_AWAKE=0、守护没在运行）"
    else explain "合盖仍会睡。想合盖也能用：在酒馆工具首页按 1（手机），再按 l（合盖不睡）安装一次。"; fi
    mismatch=$(proxy_mode_mismatch)
    [[ -n "$mismatch" ]] && { warn "$mismatch"; explain "  守护会在代理空闲时自动重启它。"; }
    show_phone_setup
    if [[ "$want" == off ]] || ask_yes "要切回电脑模式吗？（手机连不上，Mac 恢复正常睡眠）"; then
        mv "$LAN_KEY_FILE" "$LAN_KEY_FILE.off"
        watchdog_stop
        restart_proxy_if_idle
        case $? in
            0) ok "已切到电脑模式：代理只接受本机连接，Mac 恢复正常睡眠。" ;;
            1) warn "已切到电脑模式（守护已停、Mac 恢复正常睡眠），但代理正在生成回复，这次没重启："
               explain "  在它重启之前，同一 Wi-Fi 下带访问密码的手机仍然能连这个代理。"
               fix "等这条回复写完，在菜单里选「重启代理」；「检查状态」会一直提醒，直到重启。" ;;
            *) warn "已切到电脑模式，但代理没能重新启动：看上面的原因，处理后在首页启动代理。" ;;
        esac
    fi
    summary; pause_end; exit 0
fi

step "现在是：电脑模式"
explain "切到手机模式后："
explain "· 和这台 Mac 连同一个 Wi-Fi 的手机，带上访问密码就能用你的订阅；"
explain "· Mac 不会空闲睡眠，代理掉了会自动重启；装了「合盖不睡」的话合盖也不睡；"
explain "· Mac 的地址变了、断网、代理重启时，Mac 和插着线或开了无线调试的手机都会收到通知。"
explain "不要在公共 Wi-Fi（咖啡店、学校、公司）开启；密码别发给别人。"
if [[ "$want" != on ]] && ! ask_yes "切到手机模式吗？"; then
    warn "没有改动。"
    summary; pause_end; exit 0
fi
if [[ -s "$LAN_KEY_FILE.off" ]]; then
    mv "$LAN_KEY_FILE.off" "$LAN_KEY_FILE"
else
    (umask 077; LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 > "$LAN_KEY_FILE")
fi
chmod 600 "$LAN_KEY_FILE"
restart_proxy_if_idle
rc=$?
if watchdog_start; then ok "守护已启动：防睡眠、掉线自动重启、地址变化通知"
else fail "守护没有启动成功"; fix "看日志文件夹里的 watchdog.log，处理后再开一次手机模式。"; fi
case $rc in
    0) ok "已切到手机模式。" ;;
    1) warn "已切到手机模式，但代理正在生成回复，这次没重启：手机暂时还连不上。"
       explain "  守护会在代理空闲时自动重启它（一般 30 秒内），之后手机就能连；不用再开一次手机模式。" ;;
    *) warn "已切到手机模式，但代理没能启动：看上面的原因。" ;;
esac
show_phone_setup
summary
pause_end
