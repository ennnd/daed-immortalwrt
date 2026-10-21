# SPDX-License-Identifier: GPL-2.0-only
#
# daed 2.1.1 for ImmortalWrt 25.12.x (rockchip/armv8, NanoPi R2S)
#
# 上游:   https://github.com/daeuniverse/daed
# 参考:   ImmortalWrt packages feed: net/daed (GPL-2.0-only)
#
# 放置位置: <源码树或 SDK>/package/daed/
#
# 与 feed 里 1.27.0 包的主要差异:
#   1. 版本提升到 2.1.1；
#   2. daed 2.x 需要先生成 eBPF 目标文件（*.o）和前端资源
#      (webrender/web)，两者都通过 go:embed 编进二进制。
#      这里直接在源码树内 go build，避免 OpenWrt Go 包框架
#      只拷贝 .go 源码导致 embed 找不到文件；
#   3. CGO_ENABLED=0，生成静态二进制（与上游 Release 的构建方式一致），
#      不依赖目标机 libc 版本，也不需要交叉 C 编译器。
#
# 注意: 如果 feeds 里也装了 daed，请删掉 package/feeds/packages/daed
#       这个软链接，否则会出现同名包冲突（见 scripts/install-package.sh）。

include $(TOPDIR)/rules.mk

PKG_NAME:=daed
PKG_VERSION:=2.1.1
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/daeuniverse/daed.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)

# daed 的源码包含三层子模块:
#   daed -> wing (daeuniverse/dae-wing)
#         -> dae-core (daeuniverse/dae)
#               -> control/kern/headers + trace/kern/headers (dae_bpf_headers)
# OpenWrt 会递归抓取子模块并重新打 tarball，哈希无法预先给出，
# 所以这里用 skip。首次下载完成后可以执行:
#   sha256sum dl/daed-2.1.1.tar.zst
# 把结果填回本行，避免每次 make 都重新 clone。
PKG_MIRROR_HASH:=skip

PKG_LICENSE:=AGPL-3.0-only MIT
PKG_LICENSE_FILES:=LICENSE wing/LICENSE
PKG_MAINTAINER:=daeuniverse project <https://github.com/daeuniverse/daed>

# daed 的 Go module 位于 wing/ 子目录
PKG_BUILD_DIR=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/wing
PKG_BUILD_DEPENDS:=golang/host bpf-headers
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

GO_PKG:=github.com/daeuniverse/dae-wing

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/bpf.mk

# 25.12 的 packages feed 里 golang 默认版本是 1.26，正好满足
# daed 2.1.1 的 go.mod ("go 1.26.0")。如果换到更老的分支，
# 把上面的 golang/host 改成 golang1.26/host 即可。
GOLANG_MK:=$(TOPDIR)/feeds/packages/lang/golang/golang-package.mk
ifeq ($(wildcard $(GOLANG_MK)),)
  $(error 找不到 $(GOLANG_MK)。请先执行: ./scripts/feeds update -a && ./scripts/feeds install -a)
endif
include $(GOLANG_MK)

define Package/daed/Default
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  URL:=https://github.com/daeuniverse/daed
endef

# 运行期依赖:
#  - BTF / BPF 内核能力（官方 25.12.2 rockchip 内核已开启）
#  - eBPF 相关 kmod
define Package/daed
  $(call Package/daed/Default)
  TITLE:=A Modern Dashboard For dae
  # 需要内核开启 KERNEL_DEBUG_INFO_BTF 和 KERNEL_BPF_EVENTS
  DEPENDS:=$(GO_ARCH_DEPENDS) $(BPF_DEPENDS) \
    +ca-bundle +kmod-sched-core +kmod-sched-bpf +kmod-xdp-sockets-diag \
    +kmod-veth
endef

define Package/daed-geoip
  $(call Package/daed/Default)
  TITLE:=geoip for daed
  DEPENDS:=+daed +v2ray-geoip
  PKGARCH:=all
endef

define Package/daed-geosite
  $(call Package/daed/Default)
  TITLE:=geosite for daed
  DEPENDS:=+daed +v2ray-geosite
  PKGARCH:=all
endef

define Package/daed/description
  daed is a backend of dae, provides a method to bundle arbitrary
  frontend, dae and geodata into one binary.
endef

define Package/daed/conffiles
/etc/daed/wing.db
/etc/config/daed
endef

# 前端静态资源。daed 的 Release 会附带 web.zip（顶层目录为 web/）。
WEB_FILE:=$(PKG_NAME)-web-$(PKG_VERSION).zip
define Download/daed-web
	URL:=https://github.com/daeuniverse/daed/releases/download/v$(PKG_VERSION)
	URL_FILE:=web.zip
	FILE:=$(WEB_FILE)
	HASH:=7eb8f42d4860ab7311f87bda2a921bad34a6d54db7edad47466dcb8d9382fea8
endef

TAR_CMD=$(HOST_TAR) -C $(BUILD_DIR)/ $(TAR_OPTIONS)

define Build/Prepare
	$(call Build/Prepare/Default)

	( \
		mkdir -p "$(PKG_BUILD_DIR)/webrender" ; \
		unzip -q -o -d "$(PKG_BUILD_DIR)/webrender/" "$(DL_DIR)/$(WEB_FILE)" ; \
		[ -d "$(PKG_BUILD_DIR)/webrender/web" ] || { \
			echo "ERROR: web.zip 解压后没有 webrender/web 目录"; \
			exit 1; \
		} ; \
		find "$(PKG_BUILD_DIR)/webrender/web" -type f -size +4k \
			! -name '*.gz' ! -name '*.woff' ! -name '*.woff2' | \
		while IFS= read -r f ; do \
			gzip -9 -k "$$f" ; \
			if [ "$$(stat -c %s "$$f")" -lt "$$(stat -c %s "$$f.gz")" ] ; then \
				rm -f "$$f.gz" ; \
			else \
				rm -f "$$f" ; \
			fi ; \
		done ; \
	)
endef

DAE_CFLAGS:= \
	-O2 -Wall -Werror \
	-DMAX_MATCH_SET_LEN=1024 \
	-I$(BPF_HEADERS_DIR)/tools/lib \
	-I$(BPF_HEADERS_DIR)/arch/$(BPF_KARCH)/include/asm/mach-generic

# 不使用 golang-package.mk 的拷贝式构建，只需要准备缓存目录
define Build/Configure
	mkdir -p "$(GO_BUILD_CACHE_DIR)" "$(GO_MOD_CACHE_DIR)" "$(GO_PKG_BUILD_DIR)"
endef

define Build/Compile
	# 1) 先生成 eBPF 目标文件。
	#    顺序很重要：wing 的代码生成器会 import dae-core，若 BPF 代码
	#    还没生成，go generate ./... 会因 bpfObjects 未定义而失败。
	#    control 必须成功；trace 失败则自动降级（不影响 daed 主功能）。
	( \
		cd "$(PKG_BUILD_DIR)/dae-core" || exit 1 ; \
		export $(GO_PKG_BUILD_VARS) ; \
		export $(GO_BIN_PATH) ; \
		unset GOOS GOARCH GOARM GOARM64 CGO_ENABLED ; \
		export BPF_CLANG="$(CLANG)" ; \
		export BPF_STRIP_FLAG="-strip=$(LLVM_STRIP)" ; \
		export BPF_CFLAGS="$(DAE_CFLAGS)" ; \
		export BPF_TARGET="bpfel,bpfeb" ; \
		export BPF_TRACE_TARGET="$(GO_ARCH)" ; \
		echo "==> go generate control/control.go" ; \
		go generate control/control.go || exit 1 ; \
		echo "==> go generate trace/trace.go" ; \
		if go generate trace/trace.go ; then \
			echo trace > "$(PKG_BUILD_DIR)/.daed_trace" ; \
		else \
			echo "" > "$(PKG_BUILD_DIR)/.daed_trace" ; \
		fi ; \
	)
	# 2) 生成 wing 的 GraphQL 代码（host 工具，不能带 GOOS/GOARCH）
	( \
		cd "$(PKG_BUILD_DIR)" || exit 1 ; \
		export $(GO_PKG_BUILD_VARS) ; \
		export $(GO_BIN_PATH) ; \
		unset GOOS GOARCH GOARM GOARM64 CGO_ENABLED ; \
		echo "==> go generate ./... (dae-wing)" ; \
		go generate ./... || exit 1 ; \
	)
	# 3) 静态编译（CGO_ENABLED=0，与上游 Release 一致）
	( \
		cd "$(PKG_BUILD_DIR)" || exit 1 ; \
		export $(GO_PKG_BUILD_VARS) ; \
		export $(GO_BIN_PATH) ; \
		export GOOS=linux GOARCH=$(GO_ARCH) GOARM=$(GO_ARM) GOARM64=$(GO_ARM64) CGO_ENABLED=0 ; \
		TRACE_TAG=$$(cat "$(PKG_BUILD_DIR)/.daed_trace") ; \
		echo "==> go build -tags embedallowed$${TRACE_TAG:+,$$TRACE_TAG} (linux/$(GO_ARCH))" ; \
		go build -trimpath -buildvcs=false \
			-tags "embedallowed$${TRACE_TAG:+,$$TRACE_TAG}" \
			-ldflags "-s -w -X $(GO_PKG)/db.AppName=$(PKG_NAME) -X $(GO_PKG)/db.AppVersion=$(PKG_VERSION)" \
			-o dae-wing . || exit 1 ; \
	)
endef

define Package/daed/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/dae-wing $(1)/usr/bin/daed

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/daed.config $(1)/etc/config/daed

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/daed.init $(1)/etc/init.d/daed
endef

define Package/daed-geoip/install
	$(INSTALL_DIR) $(1)/usr/share/daed
	$(LN) ../v2ray/geoip.dat $(1)/usr/share/daed/geoip.dat
endef

define Package/daed-geosite/install
	$(INSTALL_DIR) $(1)/usr/share/daed
	$(LN) ../v2ray/geosite.dat $(1)/usr/share/daed/geosite.dat
endef

$(eval $(call Download,daed-web))
$(eval $(call BuildPackage,daed))
$(eval $(call BuildPackage,daed-geoip))
$(eval $(call BuildPackage,daed-geosite))
