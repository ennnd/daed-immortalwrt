# 为 FriendlyElec NanoPi R2S 编译 daed 2.1.1（ImmortalWrt 25.12.2）

本文给出在 **ImmortalWrt 25.12.2 / rockchip-armv8 / NanoPi R2S** 上使用最新版
[daed](https://github.com/daeuniverse/daed)（当前最新 **v2.1.1**，2026-09-24 发布）的完整做法。

本目录里的 `package/daed/` 是一个可以直接放进 ImmortalWrt 源码树或 SDK 的软件包，
版本为 **2.1.1**，基于 ImmortalWrt 官方 packages feed 里的 `net/daed`（1.27.0）改写。

> 说明：本套件中的 Makefile 已按 daed 2.x 的源码结构调整（eBPF 目标文件 + 前端资源都通过
> `go:embed` 编进二进制）。我无法在当前 Windows 环境里实际跑一遍 OpenWrt 构建，
> 所以第一次编译请预留时间，遇到报错先看第 9 节。

---

## 0. 先选路线

| 方案 | 做什么 | 耗时 | 适用 |
|---|---|---|---|
| **A. 不编译** | 直接装官方源里的 daed **1.27.0** | 1 分钟 | 只想尽快用上，不追求 2.x |
| **B. SDK 编译（推荐）** | 只编译 daed **2.1.1** 包，装到现有 25.12.2 固件 | 30–60 分钟 | 不想重刷固件 |
| **C. 全量编译** | 把 daed **2.1.1** 编进固件 | 1.5–3 小时 | 想定制固件/批量刷机 |

A、B 都要求路由器已经是 **ImmortalWrt 25.12.2**。官方 25.12.2 的 rockchip 内核已经开启
BTF/BPF（见下文），所以不需要重编内核。

---

## 1. 关键事实（已核对）

| 项目 | 值 |
|---|---|
| 设备/目标 | `rockchip/armv8`，`DEVICE_friendlyarm_nanopi-r2s`，`aarch64_cortex-a53`，musl |
| 内核 | 6.12.103（25.12.2） |
| 内核 BTF | 官方 25.12.2 已开 `CONFIG_KERNEL_DEBUG_INFO_BTF=y`、`CONFIG_KERNEL_BPF_EVENTS=y`、`CONFIG_KERNEL_XDP_SOCKETS=y` |
| daed 最新版 | **v2.1.1**（2026-09-24） |
| 源码结构 | `daed` → `wing`（dae-wing 子模块）→ `dae-core`（dae 子模块）→ BPF headers 子模块 |
| Go 要求 | `go 1.26.0`；25.12 的 packages feed 默认 Go 就是 **1.26** |
| daed 1.27.0 | 官方 packages 源里已有现成 `.apk`（`daed-1.27.0-r1.apk`） |
| BPF 工具链 | llvm-bpf **21.1.6**（可从 25.12.2 的 target 目录单独下载） |

参考：
- daed 仓库：<https://github.com/daeuniverse/daed>
- daed v2.1.1 Release：<https://github.com/daeuniverse/daed/releases/tag/v2.1.1>
- 25.12.2 rockchip/armv8 下载目录：<https://downloads.immortalwrt.org/releases/25.12.2/targets/rockchip/armv8/>
- 官方 25.12.2 构建配置（含内核 BTF）：<https://downloads.immortalwrt.org/releases/25.12.2/targets/rockchip/armv8/config.buildinfo>
- ImmortalWrt feed 里的 daed 包（本包的参考来源）：<https://github.com/immortalwrt/packages/blob/openwrt-25.12/net/daed/Makefile>

---

## 2. 本目录内容

```
daed-immortalwrt/
├── README.md                       # 本文件
├── .github/workflows/
│   ├── build-daed-sdk.yml          # GitHub Actions: 只编 daed 2.1.1 包
│   └── build-firmware.yml          # GitHub Actions: 全量编固件
├── package/daed/
│   ├── Makefile                    # daed 2.1.1 的 OpenWrt 包定义
│   └── files/
│       ├── daed.config             # /etc/config/daed
│       └── daed.init               # /etc/init.d/daed（procd）
├── scripts/
│   ├── install-package.sh          # 把本包放进源码树/SDK，并处理同名包冲突
│   └── device-check.sh             # 在路由器上检查 BTF/kmod 并启动 daed
└── configs/
    └── nanopi-r2s.config           # 全量编译用的 .config 片段
```

Makefile 里几个关键点：

- `PKG_VERSION:=2.1.1`，源码走 `git` 协议，**会自动递归抓取子模块**；
- `PKG_MIRROR_HASH:=skip`：因为子模块 tarball 的哈希无法预先得知；
- `PKG_BUILD_DEPENDS:=golang/host bpf-headers`：用 25.12 默认的 Go 1.26；
- 构建时先 `go generate` 生成 GraphQL 代码和 eBPF `.o`，再在源码树内直接
  `go build`（`CGO_ENABLED=0`，静态二进制，和上游 Release 的构建方式一致）。

---

## 3. 准备 Linux 构建机

推荐 **Ubuntu 22.04 / 24.04**（实体机、虚拟机、WSL2 均可）。Windows 上不能直接编。

```bash
sudo apt update
sudo apt install -y build-essential gcc g++ binutils patch bzip2 flex bison make \
  autoconf gettext texinfo unzip sharutils libncurses-dev zlib1g-dev gawk git \
  rsync python3 python3-setuptools python3-dev python3-pyelftools \
  wget curl zstd bc libssl-dev swig cpio time
```

资源建议：**4 核 CPU 以上、8 GB 内存、30 GB 以上空闲磁盘**（SDK 路线约 10–15 GB）。

---

## 4. 方案 A：直接安装官方源里的 daed 1.27.0（不编译）

在路由器上执行：

```sh
apk update
apk add daed
/etc/init.d/daed enable
uci set daed.config.enabled='1'
uci commit daed
/etc/init.d/daed start
```

浏览器打开 `http://<路由器IP>:2023`。

官方源里的包见：
<https://downloads.immortalwrt.org/releases/25.12.2/packages/aarch64_cortex-a53/packages/>

> 这是 1.27.0，不是最新 2.1.1。要 2.1.1 请走方案 B 或 C。

---

## 5. 方案 B：用 SDK 编译 daed 2.1.1（推荐）

### 5.1 下载 SDK 和 llvm-bpf

```bash
mkdir -p ~/r2s && cd ~/r2s

BASE=https://downloads.immortalwrt.org/releases/25.12.2/targets/rockchip/armv8
SDK=immortalwrt-sdk-25.12.2-rockchip-armv8_gcc-14.3.0_musl.Linux-x86_64

wget $BASE/${SDK}.tar.zst
wget $BASE/llvm-bpf-21.1.6.Linux-x86_64.tar.zst

tar --zstd -xf ${SDK}.tar.zst
tar --zstd -xf llvm-bpf-21.1.6.Linux-x86_64.tar.zst -C ${SDK}
cd ${SDK}

# 确认预编译 LLVM 被识别（必须存在）
ls -l llvm-bpf/.llvm-version
```

> `llvm-bpf` 是编译 eBPF 程序用的 clang/llvm。没有它，SDK 会尝试从源码编译 LLVM，
> 非常慢，所以务必先解压到 SDK 根目录。

### 5.2 更新 feeds

```bash
./scripts/feeds update -a

# 不要用 install -a：它会把 perl/uboot 等无关包也装进来，
# 这些包的全局 prereq 检查（rsync、python3-pyelftools）会让
# make package/daed/compile 在真正开始前就失败。
for p in bpf-headers ca-certificates golang golang1.26 golang-bootstrap; do
	./scripts/feeds install -f "$p"
done
```

### 5.3 放入 daed 2.1.1 包

```bash
# 假设本目录在 /home/you/daed-immortalwrt
sh /home/you/daed-immortalwrt/scripts/install-package.sh "$PWD"
```

脚本会做两件事：

1. 删除 `package/feeds/packages/daed`（feed 里的 1.27.0 软链接），避免同名包冲突；
2. 把 `package/daed`（2.1.1）复制进来。

> 以后如果又执行了 `./scripts/feeds install -a`，需要重新运行一次本脚本。

### 5.4 配置 BPF 工具链和要编的包

```bash
# 关键：SDK 的 Config-build.in 会把 BPF 工具链强制成 BUILD_LLVM，
# 而 Kconfig 对无 prompt 的符号会忽略 .config 里的值。
# 先打补丁，改成使用预编译的 llvm-bpf。
python3 /home/you/daed-immortalwrt/scripts/patch-sdk-config.py Config-build.in

make defconfig

# 关掉可能残留的“全选”项
sed -i \
  -e 's/^CONFIG_BUILDBOT=y/# CONFIG_BUILDBOT is not set/' \
  -e 's/^CONFIG_ALL=y/# CONFIG_ALL is not set/' \
  -e 's/^CONFIG_ALL_KMODS=y/# CONFIG_ALL_KMODS is not set/' \
  -e 's/^CONFIG_ALL_NONSHARED=y/# CONFIG_ALL_NONSHARED is not set/' \
  -e 's/^CONFIG_TARGET_ALL_PROFILES=y/# CONFIG_TARGET_ALL_PROFILES is not set/' \
  .config

cat >> .config <<'EOF'
CONFIG_PACKAGE_daed=y
CONFIG_PACKAGE_kmod-sched-core=y
CONFIG_PACKAGE_kmod-sched-bpf=y
CONFIG_PACKAGE_kmod-xdp-sockets-diag=y
CONFIG_PACKAGE_kmod-veth=y
EOF

make defconfig

# 检查：应该看到 USE_LLVM_PREBUILT=y，且没有 USE_LLVM_BUILD=y
grep -E 'CONFIG_(USE_LLVM|HAS_BPF|NEED_BPF|PACKAGE_daed|PACKAGE_kmod-sched|PACKAGE_kmod-veth|PACKAGE_kmod-xdp)' .config
grep -q '^CONFIG_USE_LLVM_BUILD=y' .config && { echo "ERROR: 会从源码编 LLVM"; exit 1; }
test -x llvm-bpf/bin/clang
```

如果打补丁后还是 `USE_LLVM_BUILD=y`，说明 `llvm-bpf` 没解压到 SDK 根目录，检查
`llvm-bpf/.llvm-version` 和 `llvm-bpf/bin/clang` 是否存在。

### 5.5 编译

```bash
make -j$(nproc) package/daed/compile V=s
```

第一次还会顺带编译 host 端的 Go 1.26 和 `bpf-headers`，再编 daed，大约 20–40 分钟。
如果提示 `go: command not found` 或找不到 `bpf-headers`，先手动编译依赖再重试：

```bash
make -j$(nproc) package/golang/host/compile
make -j$(nproc) package/bpf-headers/compile
make -j$(nproc) package/daed/compile V=s
```

### 5.6 找到产物

```bash
find bin/packages -name 'daed-2.1.1*'
```

通常会得到：

```
bin/packages/aarch64_cortex-a53/base/daed-2.1.1-r1.apk
```

（如果 SDK 被配置成 opkg，则是 `.ipk`，文件名类似
`daed_2.1.1-r1_aarch64_cortex-a53.ipk`。）

### 5.7 安装到路由器

先在路由器上确认 kmod 依赖（官方 kmods 源里都有）：

```sh
apk update
apk add kmod-sched-core kmod-sched-bpf kmod-xdp-sockets-diag kmod-veth
```

备份旧配置，卸载旧版（如果装过官方 1.27.0）：

```sh
cp -a /etc/daed /tmp/daed.bak 2>/dev/null
apk del daed 2>/dev/null
```

上传并安装：

```sh
scp daed-2.1.1-r1.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1
apk add --allow-untrusted /tmp/daed-2.1.1-r1.apk
```

### 5.8 启动

```sh
/etc/init.d/daed enable
uci set daed.config.enabled='1'
uci commit daed
/etc/init.d/daed start

# 看日志
logread -e daed | tail -n 30
```

浏览器打开 `http://<路由器IP>:2023`，首次访问按提示创建管理员账号。

也可以直接跑本目录的检查脚本：

```sh
sh device-check.sh
```

---

## 6. 方案 C：全量编译固件并内置 daed 2.1.1

### 6.1 拉源码、更新 feeds

```bash
git clone -b openwrt-25.12 https://github.com/immortalwrt/immortalwrt.git
cd immortalwrt

./scripts/feeds update -a
./scripts/feeds install -a

sh /home/you/daed-immortalwrt/scripts/install-package.sh "$PWD"
```

### 6.2 放入 llvm-bpf（避免从源码编 LLVM）

```bash
BASE=https://downloads.immortalwrt.org/releases/25.12.2/targets/rockchip/armv8
wget $BASE/llvm-bpf-21.1.6.Linux-x86_64.tar.zst
tar --zstd -xf llvm-bpf-21.1.6.Linux-x86_64.tar.zst
ls -l llvm-bpf/.llvm-version
```

### 6.3 生成 .config 并打开内核 BTF

```bash
make defconfig
cat /home/you/daed-immortalwrt/configs/nanopi-r2s.config >> .config
make defconfig
```

**必须确认**（自己编固件时 BTF 默认是关的）：

```bash
grep -E 'CONFIG_KERNEL_(DEBUG_INFO_BTF|BPF_EVENTS|XDP_SOCKETS)|CONFIG_PACKAGE_daed' .config
```

应看到：

```
CONFIG_KERNEL_DEBUG_INFO_BTF=y
CONFIG_KERNEL_BPF_EVENTS=y
CONFIG_KERNEL_XDP_SOCKETS=y
CONFIG_PACKAGE_daed=y
```

如果 `CONFIG_KERNEL_DEBUG_INFO_BTF` 没开，也可以在 `make menuconfig` 里走：

```
Global build settings
  └── Kernel build options
        ├── [*] Compile the kernel with debug information
        └── [*] Enable additional BTF type information
```

打开 BTF 会自动选中 `pahole`（`CONFIG_DWARVES`），内核会变大几 MB；R2S 从 SD 卡启动，空间足够。

### 6.4 编译

```bash
make -j$(nproc) download
make -j$(nproc) V=s
```

首次全量编译约 1.5–3 小时（取决于 CPU/网络）。调试时可先用 `make -j1 V=s` 看完整报错。

### 6.5 产物

```
bin/targets/rockchip/armv8/immortalwrt-25.12.2-rockchip-armv8-friendlyarm_nanopi-r2s-squashfs-sysupgrade.img.gz
```

刷机后 daed 已内置，但默认不启动：

```sh
uci set daed.config.enabled='1'
uci commit daed
/etc/init.d/daed enable
/etc/init.d/daed start
```

---

## 7. 包的运行期依赖与内核要求

daed 通过 eBPF 工作，运行需要：

| 要求 | 说明 |
|---|---|
| `/sys/kernel/btf/vmlinux` | 内核 BTF，CO-RE 必需；官方 25.12.2 已有 |
| `CONFIG_BPF_SYSCALL` / `CONFIG_BPF_JIT` | 25.12 默认开启 |
| `CONFIG_CGROUP_BPF` | 25.12 默认开启（cgroup v2） |
| `CONFIG_BPF_EVENTS` | trace 功能用；官方已开 |
| `kmod-sched-core`、`kmod-sched-bpf`、`kmod-xdp-sockets-diag`、`kmod-veth` | 包依赖里已声明 |
| root 权限 | procd 以 root 启动，正常 |

在路由器上确认：

```sh
ls -l /sys/kernel/btf/vmlinux
```

没有这个文件，daed 启动时会报 BTF 相关错误，必须换官方 25.12.2 内核，或自己编内核时打开
`KERNEL_DEBUG_INFO_BTF`。

---

## 8. 验证

```sh
# 1) 二进制架构
file /usr/bin/daed
# 期望: ELF 64-bit LSB executable, ARM aarch64, statically linked

# 2) 版本
/usr/bin/daed --version

# 3) 服务
/etc/init.d/daed status
logread -e daed | tail -n 30

# 4) Web
wget -qO- http://127.0.0.1:2023/ | head -c 200
```

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `go.mod requires go >= 1.26.0` | 25.12 默认 Go 1.26，正常；若用老分支，把 Makefile 里 `golang/host` 改成 `golang1.26/host`，并确认 feed 里有 `golang1.26` |
| `fatal: unable to access 'https://github.com/...'` | 子模块克隆失败。检查网络/代理；重跑 `make package/daed/download V=s` |
| `go: command not found` / 找不到 bpf-headers | 先跑 `make package/golang/host/compile` 和 `make package/bpf-headers/compile`，再编 daed |
| `cp: cannot stat '.../.go_work/build/src/github.com/daeuniverse/dae-wing'` | 跳过了 Go 的拷贝式 configure，但 `Build/InstallDev` 默认仍去拷源码。Makefile 里已用空的 `Build/InstallDev` 关掉 |
| `u-boot: Please install the Python3 elftools module` | 装 `python3-pyelftools`，或 `pip3 install --break-system-packages pyelftools` |
| `package/feeds/packages/perl failed to build`（卡在 prereq） | 不要 `feeds install -a`，按 5.2 只装 `bpf-headers ca-certificates golang golang1.26 golang-bootstrap`；perl/uboot 的全局 prereq 就不会被触发 |
| `No rule to make target 'package/daed-geoip/compile'` | 三个二进制包都来自 `package/daed/`，只有 `package/daed/compile`；geo 包已从 Makefile 移除，只编主包 |
| `ERROR: package 'bpf-headers' is not available` | 没执行 `./scripts/feeds update -a && ./scripts/feeds install -a`；SDK 的 base feed 提供 bpf-headers |
| `clang: not found` / `LLVM/clang version too old` | 没解压 `llvm-bpf-21.1.6...tar.zst`，或没选 `CONFIG_BPF_TOOLCHAIN_PREBUILT=y` |
| `pattern web: no matching files found` | web.zip 没解压成功/缓存损坏。删 `build_dir/target-*/daed-2.1.1` 和 `dl/daed-web-2.1.1.zip` 重来 |
| `undefined: loadBpf` / `undefined: bpfObjects` | eBPF 生成失败。看 `go generate control/control.go` 的输出；确认 `dae-core/control/kern/headers` 子模块存在 |
| `Duplicate package name 'daed'` | feed 的 daed 和本地包同时存在。删 `package/feeds/packages/daed`，或重跑 `install-package.sh` |
| `daed: ... BTF not found` / 启动即退出 | 内核没 BTF。换官方 25.12.2 内核，或开 `KERNEL_DEBUG_INFO_BTF` 重编 |
| `Operation not permitted`（加载 BPF） | 确认以 root 运行；确认内核 `CONFIG_BPF_SYSCALL=y`，且没有安全模块拦截 |
| `apk: UNTRUSTED signature` | 自编包未签名，安装时加 `--allow-untrusted` |
| 能启动但网页 404/空白 | 前端资源没编进去。检查包大小（应 ~20 MB 以上），以及 `webrender/web/index.html` 是否在编译目录里 |
| 装 kmod 时提示版本不匹配 | 自编 kmod 与官方内核 vermagic 不一致。直接用 25.12.2 官方 kmods 源里的包 |
| 内存不够 / 被 OOM | daed 2.x 常驻约 150–300 MB；R2S 1 GB 内存一般够用，可关闭其他插件 |

---

## 10. 以后升级 daed 版本

改 `package/daed/Makefile` 里两处：

1. `PKG_VERSION:=2.1.2`（或新版本号）
2. `Download/daed-web` 的 `HASH` 换成新 `web.zip` 的 sha256

拿新哈希：

```bash
curl -fsSL https://api.github.com/repos/daeuniverse/daed/releases/latest \
  | jq -r '.assets[] | select(.name=="web.zip") | .digest'
# 输出形如 sha256:7eb8f4...，把冒号后面的 64 位十六进制填进 HASH
```

`PKG_MIRROR_HASH:=skip` 可以保留；首次 `make download` 后也可以把真实哈希填回去，
避免每次构建都重新 clone：

```bash
sha256sum dl/daed-2.1.1.tar.zst
```

---

## 11. 用 GitHub Actions 编译

可以。GitHub 托管的 `ubuntu-latest` 就是 x86_64 Ubuntu，和 OpenWrt 官方要求的构建环境一致。
本目录已经带好两个 workflow：

| workflow | 作用 | 大概耗时 |
|---|---|---|
| `.github/workflows/build-daed-sdk.yml` | 用 SDK 只编 **daed 2.1.1 包** | 30–60 分钟 |
| `.github/workflows/build-firmware.yml` | 全量编译固件（含内核 BTF、daed） | 3–5 小时 |

### 11.1 使用步骤

1. 把 **本目录作为仓库根目录** 推到 GitHub。
   GitHub 只识别仓库根目录下的 `.github/workflows/`，所以不要把它塞进多层子目录。
2. 打开仓库的 **Actions** 页面，左侧选择 `build-daed-sdk` 或 `build-firmware`。
3. 点 **Run workflow**。
4. 跑完后在该次 run 页面底部 **Artifacts** 下载：
   - SDK 路线：`daed-2.1.1-apk`（`daed-2.1.1-r1.apk` 等）
   - 固件路线：`immortalwrt-nanopi-r2s-daed`（sysupgrade 镜像）

SDK 路线如果由 **推送 `v*` tag** 触发，还会自动把 apk 传到 Release
（workflow 里已声明 `permissions: contents: write`）。

### 11.2 注意事项

- **免费额度**：公有仓库的 Actions 分钟数免费；私有仓库会消耗账户分钟数。
- **磁盘**：SDK 路线足够；全量固件路线在 runner 上只有约 14 GB 空闲，workflow 已先删除
  dotnet/android/toolcache 等腾空间。如果仍然 `No space left on device`，说明需要更大的
  runner，或者只跑 SDK 路线。
- **超时**：单个 job 上限 6 小时；`build-firmware.yml` 设的是 360 分钟。4 vCPU 一般 3–5 小时，
  如果超时就把 `timeout-minutes` 调大没用（上限 6h），应改用 larger runner。
- **版本固定**：workflow 里写死了 `25.12.2` 和 `llvm-bpf-21.1.6`；升级时改 `env` 里的值，
  并按第 10 节更新 `package/daed/Makefile`。
- **不需要 secrets**：下载 SDK、feeds、GitHub Release 都走公开地址和内置 `GITHUB_TOKEN`。
- 不要把 workflow 改成 `pull_request_target` 去跑不可信 PR 的代码。

### 11.3 手动触发命令（可选）

装了 `gh` CLI 也可以命令行触发：

```bash
gh workflow run build-daed-sdk.yml
gh run watch
gh run download --name daed-2.1.1-apk
```

---

## 12. 备注与风险

- 本包基于 ImmortalWrt 官方 `net/daed`（1.27.0）改写，构建流程参考上游 `dae` 的
  `make ebpf` / `make bundle`：先 `go generate` 生成 eBPF 对象，再在源码树内 `go build`。
- daed 2.x 对 Go 版本、内核 BTF、clang 版本都比 1.x 更敏感；如果卡在编译阶段，
  可以先用方案 A 的 1.27.0 顶着，再按第 9 节逐项排查。
- daed 的 Web UI 监听 `0.0.0.0:2023`，默认 LAN 可访问；不要直接暴露到公网。
- 自编包没有签名，升级/安装时都需要 `--allow-untrusted`；生产环境建议自己签名或只在内网使用。
