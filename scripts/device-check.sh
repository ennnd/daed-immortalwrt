#!/bin/sh
# 在路由器上运行，检查 daed 的运行条件并启动服务。
# 用法: scp device-check.sh root@192.168.1.1:/tmp/ && ssh root@192.168.1.1 sh /tmp/device-check.sh

echo "== 系统 =="
uname -a
[ -f /etc/openwrt_release ] && . /etc/openwrt_release && echo "$DISTRIB_DESCRIPTION"

echo
echo "== 内核 BTF =="
if [ -f /sys/kernel/btf/vmlinux ]; then
	echo "OK: /sys/kernel/btf/vmlinux 存在 ($(stat -c %s /sys/kernel/btf/vmlinux) 字节)"
else
	echo "FAIL: 内核没有 BTF，dae/daed 无法加载 eBPF 程序"
fi

echo
echo "== 相关内核模块 =="
for m in sch_ingress sch_bpf veth xdp_diag; do
	if lsmod 2>/dev/null | grep -q "^$m "; then
		echo "OK: $m"
	else
		echo "WARN: $m 未加载（可能已内建，或尚未安装 kmod）"
	fi
done

echo
echo "== daed 二进制 =="
/usr/bin/daed --version 2>&1 | head -n 3

echo
echo "== 启动服务 =="
/etc/init.d/daed enable
uci set daed.config.enabled='1' 2>/dev/null
uci commit daed 2>/dev/null
/etc/init.d/daed restart
sleep 2
logread -e daed 2>/dev/null | tail -n 20

echo
echo "== HTTP 探测 =="
wget -qO- http://127.0.0.1:2023/ 2>/dev/null | head -c 120
echo
echo "完成。浏览器访问 http://<路由器IP>:2023"
