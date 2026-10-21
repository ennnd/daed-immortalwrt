#!/bin/sh
# 把本仓库里的 daed 包安装到 ImmortalWrt 源码树或 SDK 里。
#
# 用法（在 Linux 上执行）:
#   sh scripts/install-package.sh /path/to/immortalwrt
#   sh scripts/install-package.sh /path/to/immortalwrt-sdk
#
# 说明:
#   OpenWrt 会把 feeds 里的包装成 package/feeds/<feed>/<pkg> 软链接。
#   如果本地 package/daed 和 feed 里的 daed 同时存在，会出现同名包冲突，
#   所以这里先删掉 feed 的软链接，再放入本地包。
set -e

TREE="${1:-}"
if [ -z "$TREE" ]; then
	echo "用法: $0 <ImmortalWrt 源码树或 SDK 根目录>" >&2
	exit 1
fi

HERE=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -f "$TREE/rules.mk" ] || [ ! -d "$TREE/package" ]; then
	echo "错误: $TREE 看起来不是 ImmortalWrt/OpenWrt 源码树或 SDK" >&2
	exit 1
fi

# 1. 删除 feed 提供的同名包软链接（只删链接，不动 feeds/ 里的源码）
rm -rf "$TREE/package/feeds/packages/daed"

# 2. 覆盖本地包
rm -rf "$TREE/package/daed"
mkdir -p "$TREE/package"
cp -r "$HERE/package/daed" "$TREE/package/daed"

echo "OK: 已安装 daed 2.1.1 到 $TREE/package/daed"
echo "提示: 如果之后又执行了 ./scripts/feeds install -a，请重新运行本脚本。"
