#
# luci-app-singbox - sing-box-tiny 的 LuCI 管理界面
#
# 功能：订阅导入（base64 URI 列表 / 明文 URI 列表 / sing-box JSON）、
#       节点增删改、分流模式切换、DNS 设置、config.json 手工编辑与出厂重置。
#
# 设计要点：不编译任何后端代码（不需要 golang/ucode 交叉编译），
#           全部通过 LuCI 自带的 fs / uci RPC 操作路由器，
#           因此本包是 PKGARCH=all，在任何架构上都能直接用。
#
# 放置位置：<源码树>/package/luci-app-singbox/
#

include $(TOPDIR)/rules.mk

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=LuCI support for sing-box (subscription, nodes, routing)
LUCI_DESCRIPTION:=Web UI for sing-box-tiny: import nodes from subscriptions, \
	edit outbounds, switch routing mode and DNS. Every write goes through \
	"backup -> sing-box check -> atomic replace -> restart".
LUCI_DEPENDS:=+luci-base +sing-box-tiny +uclient-fetch +ca-bundle
LUCI_PKGARCH:=all

# 不做 JS 压缩：压缩器对中文与正则不友好，且容易把字符串里的 // 当注释删掉。
# 本包全部前端资源约 90KB，压缩收益不值得冒这个风险。
LUCI_MINIFY_JS:=0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
