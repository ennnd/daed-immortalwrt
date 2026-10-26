# Newifi3（Newifi D2）+ ImmortalWrt 25.12.2 + sing-box-tiny 1.14.3

用 GitHub Actions 直接编译 Newifi3 固件，内置：

- ImmortalWrt 25.12.2（`ramips/mt7621`，`d-team_newifi-d2`）
- `sing-box-tiny` **1.14.3**（来自 ImmortalWrt master 的包定义）
- `geosite-cn.srs` + `geoip-cn.srs`（编译时下载，约 87 KiB）
- DNS 分流：国内域名 → `223.5.5.5` 直连；其余 → DoH 走代理
- 流量分流：内网 / `geosite-cn` / `geoip-cn` 直连；其余走代理
- TUN 模式，system 栈

镜像预计 **20–21 MiB**，剩余 overlay 约 **10–11 MiB**。

---

## 目录

```
.github/workflows/build-newifi3-singbox.yml   # GitHub Actions
configs/newifi3-singbox.config                 # 固件 .config
newifi3-files/
└── etc/
    ├── config/sing-box                        # 开机启用
    ├── sing-box/config.json                   # 节点 + DNS + 分流
    └── uci-defaults/99-singbox-dns            # dnsmasq 只做 DHCP
```

---

## 1. 修改节点

编辑 `newifi3-files/etc/sing-box/config.json` 里的 `outbounds`。

### VLESS + Reality 节点

```json
{
  "type": "vless",
  "tag": "node1",
  "server": "1.2.3.4",
  "server_port": 443,
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    "server_name": "portal.example.com",
    "utls": { "enabled": true, "fingerprint": "chrome" },
    "reality": {
      "enabled": true,
      "public_key": "xxxxxxxx",
      "short_id": "xxxxxxxx"
    }
  }
}
```

### Shadowsocks 节点

```json
{
  "type": "shadowsocks",
  "tag": "node2",
  "server": "5.6.7.8",
  "server_port": 8388,
  "method": "aes-256-gcm",
  "password": "xxxxxxxx"
}
```

改完后：

1. 把 `YOUR_SERVER`、`YOUR_UUID`、`YOUR_SNI`、`YOUR_REALITY_PUBLIC_KEY`、`YOUR_REALITY_SHORT_ID`、`YOUR_PASSWORD` 全部替换成真实值；
2. 如果增删节点，同步修改 `urltest` 的 `outbounds` 列表：

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

`proxy` 选择器会自动使用 `auto`（测速选最快）。

> **不要把带真实节点的 config.json 推到公开仓库**。节点里有 UUID/密码，公开等于泄露。建议用私有仓库，或在推送前替换成占位值。

---

## 2. 触发编译

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

---

## 3. 刷机

1. 断电，按住 Reset，通电，保持 5–8 秒，浏览器打开 `192.168.1.1` 进入 Breed。
2. **先备份** full flash 和 EEPROM/factory（5G 校准数据）。
3. Breed → 固件更新 → 先刷 `initramfs-kernel.bin`（如果下载了），或直接刷 sysupgrade。
4. 刷完默认 `192.168.1.1`，无密码，先改密码。

> 只要 Breed 在，基本不会真砖；刷机前确认固件小于 **33,226,752 字节**。

---

## 4. 刷完后的检查

```sh
# 服务状态
/etc/init.d/sing-box status
logread -e sing-box | tail -n 50

# 配置语法（改过节点后建议先跑）
sing-box check -c /etc/sing-box/config.json

# 磁盘 / 内存
df -h
free -m

# DNS（LAN 客户端上）
nslookup www.baidu.com
nslookup www.google.com

# 分流
curl -I https://www.baidu.com
curl -I https://www.google.com
```

如果 `sing-box check` 报错，先看节点字段是否还有 `YOUR_`，以及 `urltest` 的 tag 是否对得上。

---

## 5. 说明与注意

### dnsmasq 只做 DHCP

`99-singbox-dns` 会执行：

```sh
uci set dhcp.@dnsmasq[0].port='0'
uci add_list dhcp.lan.dhcp_option='6,223.5.5.5'
```

即 dnsmasq 不再监听 53，LAN 客户端直接查 `223.5.5.5`，由 TUN 接管后按 sing-box 的 DNS 规则分流。

副作用：**路由器本身不能再用 dnsmasq 解析域名**（`apk update` 等可能受影响）。需要时临时改 `/etc/resolv.conf` 或把 `port` 改回 53。

### 1.14 配置语法

- DNS 服务器用 `type` + `server`，不是旧的 `address`；
- `cache_file` 用 `store_dns`，不是 `store_rdrc`；
- `block` outbound 已弃用，本配置没有用它；
- **1.14 必须提供 `route.default_domain_resolver`**，否则启动会报
  `missing route.default_domain_resolver ...`；本配置已加：

```json
"default_domain_resolver": {
  "server": "dns_cn"
}
```

配置可以用 1.14.3 的 sing-box 二进制先校验（把 `YOUR_...` 换成真值后）：

```sh
sing-box check -c newifi3-files/etc/sing-box/config.json
```

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
| `sing-box` 编译报 Go 版本 | 25.12.2 的 feed 需要 Go 1.26；确认 `feeds update -a` 成功 |
| linkname 相关错误 | 必须用 master 的 Makefile，不能只改 1.12.25 的版本号 |
| 磁盘不足 | workflow 已删除 dotnet/android/ghc；仍不足就减少 feeds 或换 larger runner |
| 镜像超限 | 去掉 LuCI，或改用官方 OpenWrt 基础镜像（7.50 MiB） |

### 版本

- 基础：ImmortalWrt 25.12.2
- sing-box：1.14.3（ImmortalWrt master 的包定义，PKG_HASH 已固定）
- 规则集：SagerNet `rule-set` 分支，编译时下载

以后要升 1.14.4：把 `openwrt/package/sing-box/Makefile` 里的 `PKG_VERSION` 改成 `1.14.4`，重新算 `PKG_HASH` 即可，配置不用再迁移（同属 1.14）。
