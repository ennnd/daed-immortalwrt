# Newifi3（Newifi D2）+ ImmortalWrt 25.12.2 + sing-box-tiny 1.14.3

用 GitHub Actions 编译 Newifi3 固件，**固件本身不含任何节点信息**；刷机后在路由器上手动填节点并启用。

内置：

- ImmortalWrt 25.12.2（`ramips/mt7621`，`d-team_newifi-d2`）
- `sing-box-tiny` **1.14.3**（来自 ImmortalWrt master 的包定义）
- `geosite-cn.srs` + `geoip-cn.srs`（编译时下载，约 87 KiB）
- DNS 分流：国内域名 → `223.5.5.5` 直连；其余 → DoH 走代理
- 流量分流：内网 / `geosite-cn` / `geoip-cn` 直连；其余走代理
- TUN 模式，system 栈

镜像实测 **19.0 MiB**（pad 后 19,922,944 字节，上限 31.7 MiB），剩余 overlay 约 **12 MiB**。

> 固件里的 `sing-box` 默认**不启动**（`enabled '0'`），dnsmasq 也保持正常 DNS。刷完机先正常上网，再填节点、执行 `singbox-on`。

---

## 目录

```
.github/workflows/build-newifi3-singbox.yml   # GitHub Actions
configs/newifi3-singbox.config                 # 固件 .config
newifi3-files/
├── etc/
│   ├── config/sing-box                        # 默认 enabled '0'
│   └── sing-box/config.json                   # 模板（YOUR_* 占位）
└── usr/bin/
    ├── singbox-on                             # 填好节点后启用
    └── singbox-off                            # 关闭并恢复 dnsmasq DNS
package/luci-app-singbox/                      # LuCI 面板（订阅/节点/分流/高级）
```

---

## 1. 触发编译

这些文件已经放在本仓库根目录：

- `.github/workflows/build-newifi3-singbox.yml`
- `configs/newifi3-singbox.config`
- `newifi3-files/`

把仓库推到 GitHub 后：

1. 打开 **Actions** → **Build Newifi3 sing-box firmware** → **Run workflow**。
2. 等 2–4 小时（首次全量编译）。
3. 在 run 页面底部 **Artifacts** 下载 `immortalwrt-newifi3-singbox`，里面是：

```
immortalwrt-25.12.2-ramips-mt7621-d-team_newifi-d2-squashfs-sysupgrade.bin
```

也可以推 `newifi3-*` 标签触发。

配置里的 `YOUR_*` 占位符**不影响编译**；workflow 只会打印一条 notice。

---

## 2. 刷机

1. 断电，按住 Reset，通电，保持 5–8 秒，浏览器打开 `192.168.1.1` 进入 Breed。
2. **先备份** full flash 和 EEPROM/factory（5G 校准数据）。
3. Breed → 固件更新 → 先刷 `initramfs-kernel.bin`（如果下载了），或直接刷 sysupgrade。
4. 刷完默认 `192.168.1.1`，无密码，先改密码。

> 只要 Breed 在，基本不会真砖；刷机前确认固件小于 **33,226,752 字节**。

---

## 3. 刷完后：在路由器上填节点

固件默认：

- `sing-box` 不启动；
- dnsmasq 正常监听 53，LAN 可以正常上网。

### 3.1 编辑配置

SSH 登录路由器：

```sh
ssh root@192.168.1.1
vi /etc/sing-box/config.json
```

或者从电脑上传（推荐，JSON 不容易改错）：

```powershell
scp .\config.json root@192.168.1.1:/etc/sing-box/config.json
```

把 `outbounds` 里的 `YOUR_*` 换成真实值：

| 占位符 | 含义 |
|---|---|
| `YOUR_SERVER` | 节点地址（IP 或域名） |
| `YOUR_UUID` | VLESS UUID |
| `YOUR_SNI` | Reality 的 SNI |
| `YOUR_REALITY_PUBLIC_KEY` | Reality 公钥 `pbk` |
| `YOUR_REALITY_SHORT_ID` | Reality `sid` |
| `YOUR_PASSWORD` | Shadowsocks 密码 |

如果增删节点，同步修改 `urltest` 的 `outbounds`：

```json
{
  "type": "urltest",
  "tag": "auto",
  "outbounds": ["node1", "node2", "node3"],
  "url": "https://www.gstatic.com/generate_204",
  "interval": "10m",
  "tolerance": 50
}
```

### 3.2 先校验

```sh
sing-box check -c /etc/sing-box/config.json
```

没有输出就是通过。

### 3.3 启用

```sh
singbox-on
```

它会：

1. 检查配置里是否还有 `YOUR_`；
2. `sing-box check`；
3. 启动 sing-box，确认进程在跑；
4. 成功后才把 dnsmasq 改成只做 DHCP，LAN DNS 指向 `223.5.5.5`；
5. 打印状态和最近日志。

如果 sing-box 启动失败，它**不会**改 dnsmasq，避免整个 LAN 断网。

### 3.4 关闭 / 回退

```sh
singbox-off
```

停止 sing-box，并把 dnsmasq 的 DNS 恢复监听 53，同时删掉 `singbox-on` 加的 DHCP DNS 选项，LAN 客户端重新用路由器做 DNS。

---

## 4. LuCI 面板（菜单：服务 → Sing-Box）

刷完机后不用 SSH 也能全部搞定。四个页签：

| 页签 | 能做什么 |
|---|---|
| **状态** | 服务状态 / PID / 版本 / TUN 接口 / dnsmasq 是否已被接管 / urltest 最近选中项；启用、停用、重启按钮；最近日志 |
| **节点与订阅** | 节点表格（增删改，类型联动字段：vless / vmess / trojan / shadowsocks / hysteria2 / tuic）；未填写的演示节点会标「待填写」并可一键「删除演示节点」；订阅：粘贴 URL → 立即更新 → 预览（识别 N 个、跳过 M 个及原因）→ 写入（同时清掉演示节点） |
| **分流与 DNS** | 三种分流模式（全局代理 / 大陆直连 / 全部直连）；rule-set（geosite-cn、geoip-cn）一键更新；DNS 服务器、strategy、optimistic、timeout |
| **高级** | config.json 原始编辑器（带校验）、恢复出厂配置、备份列表与回滚 |

### 4.1 订阅支持的格式

| 输入 | 说明 |
|---|---|
| base64 包装的 URI 列表 | 机场最通用，UA 用 `v2rayN/6.0` 一般就是这个格式 |
| 明文 URI 列表 | 每行一个 `vless://` / `vmess://` / `trojan://` / `ss://` / `hysteria2://` / `tuic://` |
| sing-box 配置 JSON | 含 `outbounds` 的对象，直接取其中的代理出站 |

Reality 节点的 `pbk` 必须是 43 位 base64url，不合格的会被跳过（原因 `bad-reality-key`）——否则整份配置会在 `check` 阶段因为一句 `invalid public_key` 全盘失败。

**不支持 Clash YAML**（要在前端写 YAML 解析器不划算，检测到会提示改用 URI/JSON 格式）。

订阅大小上限 **200KB**：LuCI 通过 rpcd 的 `file` 服务读文件，rpcd 的 `RPC_FILE_MAX_SIZE` 是 256KB，留了余量。200KB 大约够 300+ 个节点。

### 4.2 写入流程（每次保存都一样）

```
备份 config.json → /etc/sing-box/backup/config-<时间戳>.json（只留最近 5 份）
写 config.json.tmp
sing-box check -c config.json.tmp   ← 失败则删 tmp、原文件不动、错误原文回显
mv config.json.tmp config.json      ← 原子替换
服务在运行的话 /etc/init.d/sing-box restart
```

合并规则：**同 tag 覆盖，新 tag 追加**；写完后自动修正 `selector` / `urltest` 的 members 与 default（指向不存在的 tag 会被删掉，default 失效就取第一个成员），修正动作会显示在提示里。

### 4.3 恢复出厂

出厂原件取自 **`/rom/etc/sing-box/config.json`**——这是 squashfs 只读层（overlayfs 的 lower），只有被写过才会 copy-up，所以它永远是出厂那份，不占 overlay 空间。恢复后配置回到带 `YOUR_*` 占位符的模板（3 个演示节点也在），**不填就无法启动**；可以先在节点页点「删除演示节点」，再导入订阅。

### 4.4 面板报错怎么读

`sing-box check` 的原始输出只有一句 `initialize outbound[2]: invalid public_key`，看不出是哪个节点。面板会把下标翻回 tag，并补上字段级建议：

```
节点「node1」（vless）配置有误；Reality 公钥不合法：应为 43 位 base64url 字符
（A-Z a-z 0-9 - _），可用 sing-box generate reality-keypair 生成；
还有未填的占位符：node1(YOUR_SERVER/YOUR_UUID/...)，node2(...)，node3(...)（出厂演示节点，改成真实参数或直接删掉）；
sing-box 原始错误：FATAL[0000] initialize outbound[2]: invalid public_key
```

| 报错 | 含义 | 处理 |
|---|---|---|
| `initialize outbound[N]: invalid public_key` | 该节点的 Reality 公钥不是 43 位 base64url（出厂占位符、复制被截断都会这样） | 填真实 `pbk`，或删掉演示节点 |
| `initialize outbound[N]: decode short_id ...` | short_id 必须是偶数位十六进制（≤16 位） | 改 `sid`，留空也行 |
| `initialize outbound[N]: missing tags` | 某个 `selector` / `urltest` 没有任何成员（通常是删光了节点） | 面板会自动补 `direct` 兜底；仍报错就先加节点 |
| `duplicate outbound/endpoint tag: xxx` | tag 重名 | 改名 |
| 面板通知「配置里还有未填的占位符」 | 出厂模板的 3 个演示节点没填 | 节点页点「删除演示节点」，或逐个填好 |

出厂模板带 3 个演示节点（node1 VLESS+Reality、node2 Shadowsocks、node3 VLESS），值全是 `YOUR_*` 占位符。**它们不填就是坏的**，而 `sing-box check` 只要遇到一个就整份拒绝。所以正常流程是：订阅导入（会自动清掉这些演示节点）→ 启用；手工加节点前也可以先点一次「删除演示节点」。

### 4.5 已知限制

- **没有实时面板**：没启用 `experimental.clash_api`，所以没有流量曲线、连接列表，也**没有节点延迟测试**。判断节点好坏只能看日志里 urltest 的选择结果。
- **不支持 gRPC 传输的节点**：tiny 变体在 mips 上没有 `with_gvisor` / `with_grpc`，解析器会把 `net=grpc` 的节点跳过并计数（机场里这类节点占比不低，请留意预览页的"跳过原因"）。
- 不支持 WireGuard / naive / OpenVPN / SSR / 带 plugin 的 SS。
- TUN 只能 `stack: system`（没有 gvisor）。
- **UI 保存会重写 config.json，注释会丢**（前端没有能保留注释的 JSON 库）；想保留注释就 SSH 手改，或用「高级」页的原始编辑器（保存时同样会丢，但至少能贴回来）。

### 4.6 为什么没有 ucode/rpcd 后端

面板是纯前端（AMD 模块）+ LuCI 自带的 `fs` / `uci` RPC，没有需要交叉编译的 C 代码或 ucode 脚本。这样做的直接好处：**解析逻辑可以用 node 在本机单测**（`test/run.js`，86 条断言覆盖 JSONC 剥注释、base64、7 种 URI 解析、订阅三格式、合并与 members 修正），CI 里还会拿官方 1.14.3 二进制对"真实模板 + 解析出的节点"跑一次 `sing-box check`。权限由 ACL 精确到具体路径与可执行文件。

---

## 5. 验证

```sh
# 服务
/etc/init.d/sing-box status
logread -e sing-box | tail -n 50

# 磁盘 / 内存
df -h
free -m
```

LAN 客户端上：

```sh
nslookup www.baidu.com
nslookup www.google.com

curl -I https://www.baidu.com
curl -I https://www.google.com
```

预期：

- `baidu.com` 直连、解析走 `223.5.5.5`；
- `google.com` 走代理、解析走 DoH；
- `singbox-off` 后一切恢复直连。

---

## 6. 说明与注意

### 为什么默认不启动

固件里没有节点，直接启动会失败；而且 `dnsmasq port=0` 会让 LAN 没有 DNS。所以默认：

- `sing-box` disabled；
- dnsmasq 正常；
- 你填好节点、确认无误后再执行 `singbox-on`。

### dnsmasq 的副作用

`singbox-on` 成功后，dnsmasq 不再监听 53。**路由器本身**不能再用 dnsmasq 解析域名（`apk update` 可能受影响）。需要时：

```sh
echo 'nameserver 223.5.5.5' > /etc/resolv.conf
```

或者临时 `singbox-off`。

### 1.14 配置写法与模板改动

模板已按 1.14 校准，用官方 1.14.3 二进制实测 `sing-box check` **通过且零告警**。

#### 1.14 下已经被移除、不能再用的写法

这才是"老配置起不来"的真正原因（本模板一条都没用）：

| 旧写法 | 状态 | 现在怎么写 |
|---|---|---|
| `route.rules[].geoip` / `geosite` 字段 | 1.8 弃用、**1.12 移除**（1.14 直接报错） | `rule_set` + `geoip-cn.srs` / `geosite-cn.srs` |
| DNS 服务器 `{"address": "..."}` 老格式 | 1.12 弃用、**1.14 移除** | `{"type": "udp/https/...", "server": "..."}` |
| `inbounds[].sniff` / `domain_strategy` | 1.11 弃用、**1.13 移除** | `route.rules` 里的 `{"action": "sniff"}` |
| `block` / `dns` 特殊 outbound | 1.11 弃用、**1.13 移除** | rule action（`reject` / `hijack-dns`） |
| 缺 `route.default_domain_resolver` | 1.12 弃用、1.14 起拒绝启动 | `"default_domain_resolver": {"server": "dns_cn"}` |
| `cache_file.store_rdrc` | 1.14 弃用、1.16 移除 | `cache_file.store_dns` |

> 网上有文章说 1.14 移除了 FakeIP，**这是错的**：1.14.3 仍接受 `"type": "fakeip"`，官方弃用清单里也没有它。本模板不用 FakeIP 只是因为路由器上不需要。

#### 这一版模板相对上一版的实际改动

| # | 改动 | 原因 |
|---|---|---|
| 1 | `dns.timeout: "5s"` | 1.14 新增字段，默认 10s；路由器上没必要等这么久 |
| 2 | `dns.optimistic: true` | 1.14 新增的乐观缓存：过期先回旧记录、后台刷新，弱网/节点抖动时体感明显（不想要删掉这行） |
| 3 | 嗅探规则改成 `{"action":"sniff","sniffer":["dns","http","tls","quic"],"timeout":"300ms"}` | 原来只有 `{"action":"sniff"}`。显式列全四类：漏 `dns` 会让 `protocol: dns` 匹配不到、`hijack-dns` 失效；漏 `quic` 则 HTTP/3 嗅不到域名，一律掉到 `final` 走代理 |
| 4 | `inbounds[0].mtu: 1500` | 默认 9000，PPPoE(1492) 线路上容易出 PMTU 黑洞；PPPoE 仍偶发卡顿可降到 1492 |
| 5 | 全文件加 `//` 注释 | sing-box 的 JSON 解析器允许注释；模板是人来改的，注释比翻文档快。`singbox-on` 的 `YOUR_` 检查不受影响 |
| 6 | 其余部分（DNS 服务器格式、`rule_set`、`hijack-dns`、`default_domain_resolver`、`store_dns`、`stack: system`） | **未改** —— 上一版已经是 1.14 写法，`check` 无告警 |

改完或升级节点后，先在路由器上自检：

```sh
sing-box check -c /etc/sing-box/config.json
```

### 体积

| 项目 | 大小 |
|---|---|
| 基础镜像 | 9.88 MiB |
| `sing-box-tiny` 1.14.3 | 12.27 MiB（apk） |
| 规则集 | 87 KiB |
| 实测镜像 | **19.0 MiB**（pad 后 19,922,944 B） |
| 剩余 overlay | 约 **12 MiB** |

如果镜像超过 21 MiB，优先去掉 LuCI（`configs/newifi3-singbox.config` 里注释 `CONFIG_PACKAGE_luci=y`），可省 2–3 MiB。

### 构建失败时

| 现象 | 处理 |
|---|---|
| `v25.12.2` tag 不存在 | workflow 会自动回退到 `openwrt-25.12` 分支 |
| `dependency on 'libcronet' ...` 只是 warning | 25.12.2 feed 没有 `libcronet`，但**不会**导致 Kconfig 语法错误；workflow 删掉这两行只是为了少点噪音 |
| `tmp/.config-package.in: syntax error` / `invalid statement` | 真凶是把 master 的包 `cp` 到 `openwrt/package/sing-box`：包内 `include ../../lang/golang/golang-package.mk` 只在 feed 三级深度成立，路径失效后 `GO_ARCH_DEPENDS` 为空，config 块首行变成空的 `depends on`。workflow 已改为覆盖 `feeds/packages/net/sing-box` |
| `sing-box` 编译报 Go 版本 | 25.12.2 的 feed 需要 Go 1.26；确认 `feeds update -a` 成功 |
| linkname 相关错误 | 必须用 master 的 Makefile，不能只改 1.12.25 的版本号 |
| 磁盘不足 | workflow 已删除 dotnet/android/ghc；仍不足就减少 feeds 或换 larger runner |
| 编译跑完但 `Check image size` 报 `cannot access ...*-sysupgrade.bin` | 目标设备没被选中：`make defconfig` 静默丢弃了设备符号，回退到子目标默认设备（`ramips/mt7621` 是 **ADSLR G7**），它的 `IMAGE_SIZE` 只有 16 MB，装不下 ~20 MB 的镜像，于是谁的 sysupgrade 都没生成。单设备必须写 `CONFIG_TARGET_ramips_mt7621_DEVICE_d-team_newifi-d2=y`；`CONFIG_TARGET_DEVICE_...`（多一个 `DEVICE_`）属于 `CONFIG_TARGET_MULTI_PROFILE=y` 才可见的符号 |
| 镜像超限 | 去掉 LuCI，或改用官方 OpenWrt 基础镜像（7.50 MiB） |

### 版本

- 基础：ImmortalWrt 25.12.2
- sing-box：1.14.3（ImmortalWrt master 的包定义，PKG_HASH 已固定）
- 规则集：SagerNet `rule-set` 分支，编译时下载

以后要升 1.14.4：把 `openwrt/feeds/packages/net/sing-box/Makefile` 里的 `PKG_VERSION` 改成 `1.14.4`，重新算 `PKG_HASH` 即可，配置不用再迁移（同属 1.14）。
