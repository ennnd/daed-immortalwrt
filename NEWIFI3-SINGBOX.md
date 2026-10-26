# Newifi3（Newifi D2）+ ImmortalWrt 25.12.2 + sing-box-tiny 1.14.3

用 GitHub Actions 编译 Newifi3 固件，**固件本身不含任何节点信息**；刷机后在路由器上手动填节点并启用。

内置：

- ImmortalWrt 25.12.2（`ramips/mt7621`，`d-team_newifi-d2`）
- `sing-box-tiny` **1.14.3**（来自 ImmortalWrt master 的包定义）
- `geosite-cn.srs` + `geoip-cn.srs`（编译时下载，约 87 KiB）
- DNS 分流：国内域名 → `223.5.5.5` 直连；其余 → DoH 走代理
- 流量分流：内网 / `geosite-cn` / `geoip-cn` 直连；其余走代理
- TUN 模式，system 栈

镜像预计 **20–21 MiB**，剩余 overlay 约 **10–11 MiB**。

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

停止 sing-box，并把 dnsmasq 的 DNS 恢复监听 53。

---

## 4. 验证

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

## 5. 说明与注意

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

### 1.14 配置语法

- DNS 服务器用 `type` + `server`，不是旧的 `address`；
- `cache_file` 用 `store_dns`，不是 `store_rdrc`；
- `block` outbound 已弃用，本配置没有用它；
- **1.14 必须提供 `route.default_domain_resolver`**，否则启动会报
  `missing route.default_domain_resolver ...`；本配置已加 `{ "server": "dns_cn" }`。

### 体积

| 项目 | 大小 |
|---|---|
| 基础镜像 | 9.88 MiB |
| `sing-box-tiny` 1.14.3 | 12.27 MiB（apk） |
| 规则集 | 87 KiB |
| 预计镜像 | **20–21 MiB** |
| 剩余 overlay | **10–11 MiB** |

如果镜像超过 21 MiB，优先去掉 LuCI（`configs/newifi3-singbox.config` 里注释 `CONFIG_PACKAGE_luci=y`），可省 2–3 MiB。

### 构建失败时

| 现象 | 处理 |
|---|---|
| `v25.12.2` tag 不存在 | workflow 会自动回退到 `openwrt-25.12` 分支 |
| `dependency on 'libcronet' ... syntax error` | master 的 1.14.3 包带了 `libcronet` 条件依赖，25.12.2 feed 没有这个包；workflow 已自动删掉这两行依赖 |
| `sing-box` 编译报 Go 版本 | 25.12.2 的 feed 需要 Go 1.26；确认 `feeds update -a` 成功 |
| linkname 相关错误 | 必须用 master 的 Makefile，不能只改 1.12.25 的版本号 |
| 磁盘不足 | workflow 已删除 dotnet/android/ghc；仍不足就减少 feeds 或换 larger runner |
| 镜像超限 | 去掉 LuCI，或改用官方 OpenWrt 基础镜像（7.50 MiB） |

### 版本

- 基础：ImmortalWrt 25.12.2
- sing-box：1.14.3（ImmortalWrt master 的包定义，PKG_HASH 已固定）
- 规则集：SagerNet `rule-set` 分支，编译时下载

以后要升 1.14.4：把 `openwrt/package/sing-box/Makefile` 里的 `PKG_VERSION` 改成 `1.14.4`，重新算 `PKG_HASH` 即可，配置不用再迁移（同属 1.14）。
