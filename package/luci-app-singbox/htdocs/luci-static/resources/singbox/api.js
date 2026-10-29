'use strict';
'require baseclass';
/*
 * luci-app-singbox 的 I/O 层
 *
 * 全部走 LuCI 自带的 `fs`（rpcd file 插件）与 `uci`，不引入自建 rpcd/ucode 后端：
 *   - 能少一层需要交叉编译、无法在本机测试的 C/ucode 代码
 *   - 权限由 ACL 精确控制到具体路径与可执行文件
 *
 * 写配置的唯一入口是 saveText()：备份 → 写 .tmp → sing-box check → mv → 必要时重启。
 */
'require fs';
'require uci';
'require singbox.core as core';

var CFG = '/etc/sing-box/config.json';
var TMP = '/etc/sing-box/config.json.tmp';
var BAK_DIR = '/etc/sing-box/backup';
var ROM_CFG = '/rom/etc/sing-box/config.json';
var SUB_TMP = '/tmp/luci-singbox-sub.txt';

/*
 * dnsmasq 的上游 DNS 必须是**公网**地址，见 core.isPrivateIp() 的说明：
 * 上游若在 WAN 子网，查询会绕过 TUN，sing-box 的 hijack-dns 抓不到，
 * 国外域名就会拿到 GFW 投毒 IP（表现为"开了 sing-box 国外全挂"）。
 */
var DNS_UPSTREAM = [ '223.5.5.5', '119.29.29.29' ];

/* rpcd 的 file read 上限是 256KB（RPC_FILE_MAX_SIZE），留点余量 */
var MAX_SUB = 200 * 1024;
var MAX_BAK = 5;

var api = {};

/* ---------------- 基础 ---------------- */

api.exec = function(cmd, args) {
	return fs.exec(cmd, args || []).catch(function(e) {
		return { code: -1, stdout: '', stderr: String((e && e.message) || e) };
	});
};

/*
 * busybox 的 applet 安装路径在不同版本/配置下不完全一致（logread 有的在 /sbin 有的在 /bin），
 * 所以这里按候选路径依次尝试，第一次"命令存在且返回码不是 127"就采用。
 * ACL 里需要把每个候选路径都列出来。
 */
api.execAny = function(cmds, args) {
	var i = 0;

	function next() {
		if (i >= cmds.length)
			return Promise.resolve({ code: -1, stdout: '', stderr: _('找不到命令') + ': ' + cmds.join(', ') });

		var c = cmds[i++];

		return api.exec(c, args).then(function(res) {
			if (res.code === 127 || res.code === -1)
				return next();

			return res;
		});
	}

	return next();
};

api.pidof = function(args) {
	return api.execAny([ '/bin/pidof', '/sbin/pidof', '/usr/bin/pidof' ], args);
};

api.logread = function(args) {
	return api.execAny([ '/sbin/logread', '/bin/logread', '/usr/bin/logread' ], args);
};

api.uci = function(args) {
	return api.execAny([ '/sbin/uci', '/bin/uci', '/usr/bin/uci' ], args);
};

api.fetch = function(args) {
	return api.execAny([ '/bin/uclient-fetch', '/usr/bin/uclient-fetch' ], args);
};

api.ip = function(args) {
	return api.execAny([ '/sbin/ip', '/bin/ip', '/usr/bin/ip' ], args);
};


api.sleep = function(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
};

api.uciGet = function(pkg, sid, opt) {
	uci.unload(pkg);

	return uci.load(pkg).then(function() {
		var v = uci.get(pkg, sid, opt);

		return (v == null) ? null : v;
	}).catch(function() {
		return null;
	});
};

/* `uci show <pkg>` 的原始输出（供 core.parseUciShow 解析） */
api.uciShow = function(pkg) {
	return api.uci([ 'show', pkg ]).then(function(res) {
		return (res.code === 0) ? (res.stdout || '') : '';
	});
};

/*
 * 依次执行一组 uci 命令。
 * 单条失败不中断：`uci -q delete <不存在的选项>` 返回 1（不是 0），
 * 如果把它当致命错误，会在"全新设备本来就没有该选项"时把流程打断。
 */
api.uciSeq = function(list) {
	var self = this;

	function step(i) {
		if (i >= list.length)
			return Promise.resolve();

		return self.uci(list[i]).then(function() { return step(i + 1); });
	}

	return step(0);
};

/* ---------------- 配置文件 ---------------- */

api.readText = function() {
	return fs.read(CFG).catch(function() { return null; });
};

api.readConfig = function() {
	return fs.read(CFG).then(function(text) {
		var cfg = null, err = null;

		try {
			cfg = core.parseJsonc(text);
		}
		catch (e) {
			err = e;
		}

		return { text: text, cfg: cfg, error: err ? String(err.message || err) : null };
	}).catch(function(e) {
		throw new Error(_('读取配置失败') + ': ' + String((e && e.message) || e));
	});
};

api.backup = function(note) {
	var stamp = Math.floor(Date.now() / 1000);

	return api.readText().then(function(text) {
		if (text == null)
			throw new Error(_('当前没有 config.json 可备份'));

		return fs.stat(BAK_DIR).catch(function() {
			return api.exec('/bin/mkdir', [ '-p', BAK_DIR ]);
		}).then(function() {
			var name = BAK_DIR + '/config-' + stamp + '.json';

			return fs.write(name, text).then(function() {
				return api.pruneBackups();
			}).then(function() {
				return name;
			});
		});
	});
};

api.pruneBackups = function() {
	return fs.list(BAK_DIR).catch(function() {
		return [];
	}).then(function(entries) {
		var names = entries
			.filter(function(e) { return /^config-\d+\.json$/.test(e.name); })
			.map(function(e) { return e.name; })
			.sort(function(a, b) {
				return parseInt(b.substring(7), 10) - parseInt(a.substring(7), 10);
			});

		var old = names.slice(MAX_BAK);

		return Promise.all(old.map(function(n) {
			return fs.remove(BAK_DIR + '/' + n).catch(function() {});
		}));
	});
};

api.listBackups = function() {
	return fs.list(BAK_DIR).catch(function() {
		return [];
	}).then(function(entries) {
		return entries
			.filter(function(e) { return /^config-\d+\.json$/.test(e.name); })
			.map(function(e) {
				return {
					name: e.name,
					time: parseInt(e.name.substring(7), 10) * 1000,
					size: e.size || 0
				};
			})
			.sort(function(a, b) { return b.time - a.time; });
	});
};

api.checkText = function(text) {
	return fs.write(TMP, text).then(function() {
		return api.exec('/usr/bin/sing-box', [ 'check', '-c', TMP ]);
	}).then(function(res) {
		fs.remove(TMP).catch(function() {});
		return res;
	});
};

/*
 * 把 sing-box check 的失败输出翻成可操作的错误。
 * 原始输出只有 "initialize outbound[2]: invalid public_key" 这种，
 * 看不出是哪个节点，所以这里补上 tag、类型、字段问题，以及是否还有占位符。
 */
api.checkFailure = function(text, res) {
	var raw = core.trimStr((res && (res.stderr || res.stdout)) || '');
	var info = core.explainCheckError(text, raw);
	var cfg = null, parts = [];

	try {
		cfg = core.parseJsonc(text || '');
	}
	catch (e) {
		cfg = null;
	}

	if (info.tag)
		parts.push(_('节点「') + info.tag + '」' +
			(info.type ? '（' + info.type + '）' : '') + _('配置有误'));
	else if (info.kind)
		parts.push(_('第 ') + (info.index + 1) + _(' 项 ') + info.kind + _(' 配置有误'));

	if (info.hint)
		parts.push(info.hint);

	var ph = core.scanPlaceholders(cfg);

	if (ph.length)
		parts.push(_('还有未填的占位符：') + core.placeholderText(ph) +
			_('（出厂演示节点，改成真实参数或直接删掉）'));

	if (raw)
		parts.push(_('sing-box 原始错误：') + raw);

	return new Error(parts.join(_('；')) || _('sing-box check 失败'));
};

/*
 * 唯一的写配置入口。返回 { restarted: bool, checked: bool }
 * 任何一步失败都会抛错，且原文件保持不变（.tmp 会被删掉）。
 */
api.saveText = function(text, note) {
	return api.backup(note || 'ui').then(function() {
		return fs.write(TMP, text);
	}).then(function() {
		return api.exec('/usr/bin/sing-box', [ 'check', '-c', TMP ]);
	}).then(function(res) {
		if (res.code !== 0) {
			return fs.remove(TMP).catch(function() {}).then(function() {
				throw api.checkFailure(text, res);
			});
		}

		return api.exec('/bin/mv', [ '-f', TMP, CFG ]);
	}).then(function(res) {
		if (res.code !== 0)
			throw new Error(_('写入失败') + ': ' + core.trimStr(res.stderr || ''));

		return api.isRunning();
	}).then(function(st) {
		if (!st.running)
			return { restarted: false };

		return api.restart().then(function() {
			return { restarted: true };
		});
	});
};

api.saveConfig = function(cfg, note) {
	return api.saveText(JSON.stringify(cfg, null, 2) + '\n', note);
};

/*
 * 恢复出厂：优先用 /rom 里的原件（squashfs 只读层，永远干净），
 * 退回 /etc/sing-box/config.default.json。写入仍然走 saveText（会先备份再 check）。
 */
api.resetFactory = function() {
	return fs.read(ROM_CFG).catch(function() {
		return fs.read('/etc/sing-box/config.default.json');
	}).catch(function() {
		throw new Error(_('出厂配置不可用（/rom 与 config.default.json 都读不到）'));
	}).then(function(text) {
		if (core.trimStr(text) === '')
			throw new Error(_('出厂配置是空文件，已中止'));

		return api.saveText(text, _('恢复出厂配置'));
	});
};

api.restoreBackup = function(name) {
	if (!/^config-\d+\.json$/.test(name))
		throw new Error(_('备份文件名不合法'));

	return fs.read(BAK_DIR + '/' + name).then(function(text) {
		return api.saveText(text, _('回滚到 ') + name);
	});
};

/* ---------------- 服务状态与控制 ---------------- */

api.isRunning = function() {
	return api.pidof([ 'sing-box' ]).then(function(res) {
		if (res.code === 127)
			return api.exec('/etc/init.d/sing-box', [ 'status' ]).then(function(r2) {
				return { running: r2.code === 0, pid: '' };
			});

		var pid = core.trimStr(res.stdout);

		return { running: res.code === 0 && pid !== '', pid: pid.split(/\s+/)[0] || '' };
	});
};

api.version = function() {
	return api.exec('/usr/bin/sing-box', [ 'version' ]).then(function(res) {
		var line = (res.stdout || '').split('\n')[0];

		return core.trimStr(line) || '—';
	});
};

api.tunIfaces = function() {
	return api.ip([ '-o', 'link', 'show' ]).then(function(res) {
		var out = [];

		(res.stdout || '').split('\n').forEach(function(line) {
			var m = /^\d+:\s+(tun[A-Za-z0-9_.-]*):\s+<([^>]*)>/.exec(line);

			if (!m)
				return;

			if (m[2].indexOf('UP') >= 0)
				out.push(m[1]);
		});

		return out;
	});
};

api.logTail = function(n) {
	return api.logread([ '-e', 'sing-box' ]).then(function(res) {
		var lines = (res.stdout || '').split('\n').filter(function(l) { return l !== ''; });

		return lines.slice(-1 * (n || 20)).join('\n');
	});
};

api.restart = function() {
	return api.exec('/etc/init.d/sing-box', [ 'restart' ]);
};

api.status = function() {
	return Promise.all([
		api.isRunning(),
		api.version(),
		api.tunIfaces(),
		api.logTail(40),
		api.uciGet('dhcp', '@dnsmasq[0]', 'port'),
		api.uciGet('dhcp', 'lan', 'dhcp_option'),
		api.uciGet('sing-box', 'main', 'enabled'),
		api.uciGet('dhcp', '@dnsmasq[0]', 'noresolv'),
		api.uciGet('dhcp', '@dnsmasq[0]', 'server'),
		api.uciShow('firewall')
	]).then(function(r) {
		var opts = Array.isArray(r[5]) ? r[5] : (r[5] ? [ r[5] ] : []);
		var upstream = Array.isArray(r[8]) ? r[8] : (r[8] ? [ r[8] ] : []);
		var noresolv = (String(r[7]) === '1');

		/* 旧版"DNS 接管"留下的残留：port=0 + LAN 下发 6,223.5.5.5。
		   这种状态下 :53 无人监听 → 整网解析瘫痪，必须提示用户。 */
		var legacyTakeover = (String(r[4]) === '0' && opts.indexOf('6,223.5.5.5') >= 0);

		/* 查询会不会被 sing-box 的 hijack-dns 接管：
		   上游是公网地址 → 查询走 TUN → 被接管 → 国外域名由 DoH 经代理解析。
		   上游是内网地址（上游路由器）→ 绕过 TUN → 国外域名会被投毒。 */
		var publicUpstream = upstream.length > 0 && upstream.every(function(s) {
			return !core.isPrivateIp(s);
		});
		var viaSingbox = noresolv && publicUpstream;

		var fsecs = core.parseUciShow(r[9], 'firewall');
		var fz = core.uciZoneStatus(fsecs);
		var v6 = core.uciIpv6BlockStatus(fsecs);

		var selected = '';

		(r[3] || '').split('\n').forEach(function(l) {
			if (l.indexOf('urltest') >= 0 && l.indexOf('selected') >= 0)
				selected = l;
		});

		return {
			running: r[0].running,
			pid: r[0].pid,
			version: r[1],
			tun: r[2],
			log: r[3],
			dnsmasq_port: r[4],
			dns_taken: legacyTakeover,
			dns_noresolv: noresolv,
			dns_upstream: upstream,
			dns_via_singbox: viaSingbox,
			dns_upstream_private: (upstream.length > 0 && !publicUpstream),
			fw_zone_ok: fz.ok,
			fw_zone_problems: fz.problems,
			ipv6_block_ok: v6.ok,
			ipv6_block_problems: v6.problems,
			uci_enabled: String(r[6]) === '1',
			urltest_last: selected
		};
	});
};

/* 防御：/etc/config/sing-box 若漏写 conffile，sing-box.init 会拼成
   `sing-box run -c ""`，启动直接报 "read config at : open : no such file"。
   启用前先确认 conffile 已设置，缺失则补上并 commit（让旧固件也能在 UI 里自救）。 */
api.ensureConffile = function() {
	var self = api;

	return self.uciGet('sing-box', 'main', 'conffile').then(function(cf) {
		if (cf && core.trimStr(cf))
			return null;

		return self.uci([ 'set', 'sing-box.main.conffile=' + CFG ])
			.then(function() { return self.uci([ 'commit', 'sing-box' ]); });
	});
};

/* ---------------- 环境准备：防火墙区 + DNS 上游 ---------------- */

/*
 * 确保 singbox 防火墙区存在且策略正确。
 *
 * 与 /usr/bin/singbox-on 里的 ensure_singbox_fw 一一对应
 * （**改一处必须改两处**，否则面板和命令行行为会漂移——这个坑踩过两次）。
 *
 * 为什么必须有：
 *   - TUN 设备 tun0 若不在任何区里，fw4 的 forward 默认 DROP，
 *     LAN 客户端的流量进不了 tun0（路由器自己能上、客户端全都上不了）；
 *   - 区策略若是 input=REJECT，tun0 的回程包会被 reject，
 *     路由器自身经代理出站直接报 "Operation not permitted"。
 */
api.ensureFirewallZone = function() {
	var self = this;

	return self.uciShow('firewall').then(function(text) {
		var secs = core.parseUciShow(text, 'firewall');
		var z = core.uciFindZone(secs, 'singbox');

		if (!z) {
			return self.uci([ 'add', 'firewall', 'zone' ]).then(function(res) {
				z = String(res.stdout || '').trim();

				if (!z)
					throw new Error(_('创建 singbox 防火墙区失败'));

				return self.uci([ 'set', 'firewall.' + z + '.name=singbox' ]).then(function() {
					return self.finishFirewallZone(secs, z);
				});
			});
		}

		return self.finishFirewallZone(secs, z);
	});
};

api.finishFirewallZone = function(secs, z) {
	var self = this;
	var cmds = [
		[ 'set', 'firewall.' + z + '.input=ACCEPT' ],
		[ 'set', 'firewall.' + z + '.output=ACCEPT' ],
		[ 'set', 'firewall.' + z + '.forward=ACCEPT' ],
		[ 'set', 'firewall.' + z + '.masq=0' ]
	];

	if (!core.uciListHas((secs[z] || {})['device'], 'tun0'))
		cmds.push([ 'add_list', 'firewall.' + z + '.device=tun0' ]);

	/*
	 * 删除旧版遗留的 wan->singbox 转发（幂等修复）。
	 *
	 * 刻意不建 wan->singbox：路由器自身发起的连接走 output 链
	 * （output_singbox -> accept_to_singbox），不经过 forward 链，
	 * 所以这条转发对"路由器自身走代理"没有任何作用（实测删掉后
	 * 路由器自身与 LAN 客户端的代理都照常，出口 IP 仍是代理节点）。
	 * 留着反而会放行"从 WAN 侧转发给 tun0"的流量，没有必要。
	 *
	 * 删除必须按索引数值降序：删掉一个后后面的索引会前移，
	 * 顺序错了会漏删或删错段。
	 */
	var stale = [];

	Object.keys(secs).forEach(function(sid) {
		var s = secs[sid];

		if (s.src === 'wan' && s.dest === 'singbox')
			stale.push(sid);
	});

	stale.sort(function(a, b) {
		var na = parseInt((a.match(/\[(\d+)\]/) || [ 0, 0 ])[1], 10);
		var nb = parseInt((b.match(/\[(\d+)\]/) || [ 0, 0 ])[1], 10);

		return nb - na;
	}).forEach(function(sid) {
		cmds.push([ '-q', 'delete', 'firewall.' + sid ]);
	});

	return self.uciSeq(cmds).then(function() {
		return self.uci([ 'commit', 'firewall' ]);
	}).then(function() {
		/* lan->singbox：给 LAN 客户端的流量进 TUN，缺了就补 */
		var need = [];

		if (!core.uciFindForwarding(secs, 'lan', 'singbox'))
			need.push([ 'lan', 'singbox' ]);

		function addNext(i) {
			if (i >= need.length)
				return Promise.resolve();

			return self.addForwarding(need[i][0], need[i][1]).then(function() {
				return addNext(i + 1);
			});
		}

		return addNext(0);
	}).then(function() {
		/* 规则要生效：fw4 reload；fw4 不可用就退回重启 firewall 服务 */
		return self.execAny([ '/usr/sbin/fw4', '/sbin/fw4', '/bin/fw4' ], [ 'reload' ]).then(function(res) {
			if (res.code === 0)
				return res;

			return self.exec('/etc/init.d/firewall', [ 'restart' ]);
		});
	});
};

api.addForwarding = function(src, dest) {
	var self = this;

	return self.uci([ 'add', 'firewall', 'forwarding' ]).then(function(res) {
		var s = String(res.stdout || '').trim();

		if (!s)
			throw new Error(_('创建防火墙转发规则失败'));

		return self.uci([ 'set', 'firewall.' + s + '.src=' + src ])
			.then(function() { return self.uci([ 'set', 'firewall.' + s + '.dest=' + dest ]); })
			.then(function() { return self.uci([ 'commit', 'firewall' ]); });
	});
};

/*
 * 确保存在"阻断 LAN -> WAN IPv6"的防火墙规则。
 *
 * 为什么必须做：sing-box 的 TUN 只分配了 IPv4 地址(172.19.0.1/30)，
 * 完全不处理 IPv6——ip -6 rule 里没有任何指向 table 2022 的策略路由。
 * 而运营商下发的 /64 前缀会经 RA/SLAAC 直接给 LAN 客户端全局 IPv6 地址，
 * 客户端的 IPv6 流量走 fw4 的 lan->wan 直接出 WAN，**绕过 TUN 和代理**，
 * 网站看到的就是客户端真实的运营商 IPv6，代理形同虚设。
 *
 * 节点侧本来也没有 IPv6 出口（代理承载不了这条路径），
 * 所以正确做法是把 LAN 的 IPv6 出网 REJECT 掉：
 * REJECT 会回 ICMPv6 unreachable，客户端立刻回退 IPv4；
 * 用 DROP 则要干等连接超时。
 */
api.ensureNoIpv6Bypass = function() {
	var self = this;

	return self.uciShow('firewall').then(function(text) {
		var secs = core.parseUciShow(text, 'firewall');
		var r = core.uciFindIpv6BlockRule(secs);

		if (!r) {
			return self.uci([ 'add', 'firewall', 'rule' ]).then(function(res) {
				r = String(res.stdout || '').trim();

				if (!r)
					throw new Error(_('创建 IPv6 防护规则失败'));

				return self.uci([ 'set', 'firewall.' + r + '.name=Block-LAN-IPv6-Egress' ])
					.then(function() { return self.finishIpv6Block(r); });
			});
		}

		return self.finishIpv6Block(r);
	});
};

api.finishIpv6Block = function(r) {
	var self = this;
	var cmds = [
		[ 'set', 'firewall.' + r + '.src=lan' ],
		[ 'set', 'firewall.' + r + '.dest=wan' ],
		[ 'set', 'firewall.' + r + '.family=ipv6' ],
		[ 'set', 'firewall.' + r + '.proto=all' ],
		[ 'set', 'firewall.' + r + '.target=REJECT' ]
	];

	return self.uciSeq(cmds).then(function() {
		return self.uci([ 'commit', 'firewall' ]);
	});
};

/*
 * 把 dnsmasq 的上游 DNS 改成公网解析器，并禁用读 resolv.conf。
 *
 * 这是"开了 sing-box 国外全挂"的真正根因（不是节点、不是 MTU、不是防火墙）：
 * 上游路由器在 WAN 子网，dnsmasq 查它的流量命中 route 规则
 * ip_is_private→direct 直接出 WAN、**绕过 TUN**，sing-box 的 hijack-dns
 * 规则根本抓不到 → 国外域名拿到 GFW 投毒 IP → 连过去被上游回
 * admin-prohibited（connect 报 EPERM / "Operation not permitted"）。
 *
 * 改成公网解析器后：查询走 TUN → 被 hijack-dns 接管 → sing-box 按自己的规则
 * 分流（国内→dns_cn 直连、国外→DoH 1.1.1.1 走代理）→ 拿到真实 IP。
 *
 * 注意：**不能**用"dnsmasq port=0 + LAN 下发 6,223.5.5.5"那套接管做法——
 * 本配置 sing-box 并不监听 :53，接管后 :53 无人监听，整网解析瘫痪。
 */
api.ensureDnsUpstream = function() {
	var self = this;
	var cmds = [
		/* 修掉旧版"DNS 接管"留下的状态：dnsmasq port=0 会让 :53 无人监听，
		   整网解析瘫痪；LAN 被下发 6,223.5.5.5 会让客户端绕过路由器解析。 */
		[ 'set', 'dhcp.@dnsmasq[0].port=53' ],
		[ '-q', 'delete', 'dhcp.lan.dhcp_option' ],
		[ 'set', 'dhcp.@dnsmasq[0].noresolv=1' ],
		[ '-q', 'delete', 'dhcp.@dnsmasq[0].server' ]
	];

	DNS_UPSTREAM.forEach(function(s) {
		cmds.push([ 'add_list', 'dhcp.@dnsmasq[0].server=' + s ]);
	});

	return self.uciSeq(cmds)
		.then(function() { return self.uci([ 'commit', 'dhcp' ]); })
		.then(function() { return self.exec('/etc/init.d/dnsmasq', [ 'restart' ]); });
};

/* 启用：完全按 /usr/bin/singbox-on 的顺序，失败回滚 */
api.enable = function() {
	var self = api;
	var cfgText = '';

	return self.ensureConffile().then(function() {
		return self.readConfig();
	}).then(function(cfgres) {
		var ph = core.scanPlaceholders(cfgres.cfg);

		if (ph.length)
			throw new Error(_('配置里还有未填的占位符：') + core.placeholderText(ph) +
				_('。请到「节点」页把它们改成真实参数，或用「删除演示节点」清掉'));

		if (cfgres.error)
			throw new Error(_('配置不是合法 JSON') + ': ' + cfgres.error);

		cfgText = cfgres.text;

		return self.exec('/usr/bin/sing-box', [ 'check', '-c', CFG ]);
	}).then(function(res) {
		if (res.code !== 0)
			throw self.checkFailure(cfgText, res);

		/* 防火墙必须排在 sing-box 之前：fw4 reload 会把 TUN 规则冲掉，
		   所以先 reload 防火墙、再启动 sing-box。 */
		return self.ensureFirewallZone();
	}).then(function() {
		/* 防 IPv6 绕过代理：TUN 只有 IPv4，客户端 IPv6 会直连 WAN 泄漏真实 IP */
		return self.ensureNoIpv6Bypass();
	}).then(function() {
		/* dnsmasq 上游改公网解析器（否则国外域名被投毒，见 ensureDnsUpstream 注释） */
		return self.ensureDnsUpstream();
	}).then(function() {
		return self.uci([ 'set', 'sing-box.main.enabled=1' ]);
	}).then(function() {
		return self.uci([ 'commit', 'sing-box' ]);
	}).then(function() {
		return self.exec('/etc/init.d/sing-box', [ 'enable' ]);
	}).then(function() {
		return self.restart();
	}).then(function() {
		var tries = 0;

		function poll() {
			return self.isRunning().then(function(st) {
				if (st.running)
					return st;

				if (++tries >= 10)
					return st;

				return self.sleep(1000).then(poll);
			});
		}

		return poll();
	}).then(function(st) {
		if (!st.running) {
			/* 回滚：把 enabled 关掉并停服务 */
			return self.uci([ 'set', 'sing-box.main.enabled=0' ])
				.then(function() { return self.uci([ 'commit', 'sing-box' ]); })
				.then(function() { return self.exec('/etc/init.d/sing-box', [ 'stop' ]); })
				.then(function() { return self.logTail(20); })
				.then(function(log) {
					throw new Error(_('sing-box 启动失败，已回滚') + '\n' + log);
				});
		}

		return { running: true, pid: st.pid };
	});
};

api.disable = function() {
	var self = api;

	return self.exec('/etc/init.d/sing-box', [ 'stop' ])
		.then(function() { return self.uci([ 'set', 'sing-box.main.enabled=0' ]); })
		.then(function() { return self.uci([ 'commit', 'sing-box' ]); })
		/* 清掉旧版本（DNS 接管版）可能留下的残留状态。
		   dnsmasq 的上游保持公网解析器：这样即便 sing-box 停着，
		   DNS 也不会再被上游路由器的投毒答案带偏。 */
		.then(function() { return self.uci([ 'set', 'dhcp.@dnsmasq[0].port=53' ]); })
		.then(function() { return self.uci([ '-q', 'delete', 'dhcp.lan.dhcp_option' ]); })
		.then(function() { return self.uci([ 'commit', 'dhcp' ]); })
		.then(function() { return self.exec('/etc/init.d/dnsmasq', [ 'restart' ]); })
		.then(function() { return { running: false }; });
};

/*
 * 切换 proxy selector 的当前出口：把 default 改成 member（必须是该出站 outbounds
 * 里的成员），保存并重载。因为没开 Clash API，selector 只能在启动时按 default
 * 选一个、运行时不热切，所以这里改完走 saveConfig（= 备份→check→写入→若运行中
 * 则 restart），生效需要一次重启。obTag 默认 "proxy"。
 */
api.selectOutbound = function(obTag, member) {
	var self = api;

	obTag = obTag || 'proxy';

	if (!member)
		return Promise.reject(new Error(_('请选择一个出口')));

	return self.readConfig().then(function(cfgres) {
		var cfg = cfgres.cfg;

		if (!cfg)
			throw new Error(cfgres.error || _('配置解析失败'));

		core.applySelectorDefault(cfg, obTag, member);

		return self.saveConfig(cfg, _('切换出口到 ') + member);
	});
};

/* ---------------- 订阅 ---------------- */

api.fetchSubscription = function(url, ua) {
	if (!/^https?:\/\//i.test(core.trimStr(url)))
		return Promise.reject(new Error(_('订阅地址必须是 http(s)://')));

	var args = [ '-q', '-O', SUB_TMP, '--timeout=20', '--user-agent', ua || 'v2rayN/6.0', url ];

	return api.fetch(args).then(function(res) {
		if (res.code !== 0)
			throw new Error(_('下载失败') + ': ' + core.trimStr(res.stderr || res.stdout));

		return fs.read(SUB_TMP);
	}).then(function(text) {
		fs.remove(SUB_TMP).catch(function() {});

		if (text == null)
			throw new Error(_('下载结果为空'));

		if (text.length >= MAX_SUB)
			throw new Error(_('订阅内容超过 200KB 上限（rpcd 读取限制），请改用节点较少的订阅'));

		if (core.trimStr(text) === '')
			throw new Error(_('下载结果为空'));

		return text;
	});
};

/*
 * 规则集更新
 * ==========
 *
 * 数据源：SagerNet 的 rule-set 分支（不是 release）。
 *   注意：SagerNet 的 **release** 里现在只有 `.db`（那是给别的程序用的格式），
 *   实测 sing-box 1.14.3 拒绝加载，报 "invalid sing-box rule-set file"。
 *   真正能给 sing-box 用的是 `rule-set` 分支下的 `.srs`（魔数 "SRS\x01"）。
 *
 * 真实大小（2026-10）：geoip-cn.srs ≈ 33KB、geosite-cn.srs ≈ 55KB。
 * 所以**绝不能**用"小于 100KB 判失败"——那会把两个合法文件都删掉。
 * 完整性改用下面四道校验，任何一道不过就不落盘、保留旧文件：
 *
 *   1. sing-box rule-set decompile  → 能完整解出来（截断文件会 "unexpected EOF"，
 *      HTML 错误页会 "invalid sing-box rule-set file"，空文件会 "EOF"）
 *   2. 解出来的 JSON 里有非空 rules 数组
 *   3. 正向探针：拿一个"必定属于该集合"的 IP/域名去 match，必须命中
 *   4. 反向探针：拿一个"必定不属于该集合"的去 match，必须不命中
 *
 * 下载源做多镜像回退（GitHub raw / jsDelivr / ghproxy），任一成功即可。
 */
var RULESET_SOURCES = {
	'geoip-cn': {
		file: 'geoip-cn.srs',
		mirrors: [
			'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
			'https://cdn.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs',
			'https://ghproxy.net/https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs'
		],
		/* 223.5.5.5 是阿里 DNS，必属 CN；8.8.8.8 必不属 CN */
		matchAny: [ '223.5.5.5', '119.29.29.29' ],
		matchNone: [ '8.8.8.8' ]
	},
	'geosite-cn': {
		file: 'geosite-cn.srs',
		mirrors: [
			'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
			'https://cdn.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs',
			'https://ghproxy.net/https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs'
		],
		/* baidu.com 必属 CN 站点；google.com 必不属 CN */
		matchAny: [ 'baidu.com', 'qq.com' ],
		matchNone: [ 'google.com' ]
	}
};

api.ruleSetSupported = function(tag) {
	return !!RULESET_SOURCES[tag];
};

api.ruleSetPath = function(tag) {
	var spec = RULESET_SOURCES[tag];

	return '/etc/sing-box/rule-set/' + (spec ? spec.file : tag + '.srs');
};

/* 依次尝试镜像下载到 dst；全部失败则 reject */
api.downloadRuleSet = function(tag, dst) {
	var spec = RULESET_SOURCES[tag];
	var i = 0;
	var errors = [];

	function next() {
		if (i >= spec.mirrors.length)
			return Promise.reject(new Error(_('所有下载源都失败') + '：' + errors.join('；')));

		var url = spec.mirrors[i++];

		return api.fetch([ '-q', '-O', dst, '--timeout=30', url ]).then(function(res) {
			if (res.code !== 0) {
				errors.push(core.trimStr(res.stderr || res.stdout || ('rc=' + res.code)).slice(0, 80));
				return next();
			}

			return { url: url };
		});
	}

	return next();
};

/*
 * 对一个候选 .srs 做完整校验。返回 Promise<{ rules, size }>，失败则 reject。
 */
api.validateRuleSet = function(tag, tmp) {
	var spec = RULESET_SOURCES[tag];
	var tmpJson = tmp + '.json';

	function fail(msg) {
		return fs.remove(tmp).catch(function() {})
			.then(function() { return fs.remove(tmpJson).catch(function() {}); })
			.then(function() { throw new Error(msg); });
	}

	/* 第 1 道：decompile —— 结构完整性（截断/HTML/空文件都会在这里被抓到） */
	return api.exec('/usr/bin/sing-box', [ 'rule-set', 'decompile', tmp, '-o', tmpJson ])
		.then(function(res) {
			if (res.code !== 0) {
				var why = core.trimStr(res.stderr || res.stdout || ('rc=' + res.code));

				if (/unexpected EOF|EOF/i.test(why))
					return fail(_('文件不完整（下载被截断）') + '：' + why.slice(0, 100));
				if (/invalid sing-box rule-set/i.test(why))
					return fail(_('不是有效的 .srs 文件（可能下到了错误页）') + '：' + why.slice(0, 100));

				return fail(_('rule-set 解析失败') + '：' + why.slice(0, 100));
			}

			/* 第 2 道：解出来的 JSON 结构 */
			return fs.read(tmpJson);
		}).then(function(txt) {
			var v = core.validateRuleSetJson(txt);

			if (!v.ok) {
				if (v.error === 'no-rules')
					return fail(_('规则集里没有任何规则，已丢弃'));

				return fail(_('规则集内容损坏（JSON 解析失败），已丢弃'));
			}

			/* 第 3 道：正向探针，必须至少命中一个 */
			return api.exec('/usr/bin/sing-box', [ 'rule-set', 'match', '--format', 'binary', tmp, spec.matchAny[0] ])
				.then(function(res) {
					if (!core.ruleSetMatchHit(res.stdout))
						return fail(_('内容校验未通过：') + spec.matchAny[0] + _(' 不在该规则集里，已丢弃'));

					/* 第 4 道：反向探针，必须不命中 */
					return api.exec('/usr/bin/sing-box', [ 'rule-set', 'match', '--format', 'binary', tmp, spec.matchNone[0] ]);
				}).then(function(res) {
					if (core.ruleSetMatchHit(res.stdout))
						return fail(_('内容校验未通过：') + spec.matchNone[0] + _(' 不该在该规则集里，已丢弃'));

					return fs.stat(tmp).catch(function() { return null; });
				}).then(function(st) {
					return fs.remove(tmpJson).catch(function() {}).then(function() {
						return { rules: v.rules, size: (st && st.size) ? st.size : 0 };
					});
				});
		}).catch(function(e) {
			/* fail() 抛出的错误直接透传；其它异常也清理临时文件 */
			if (e && e.message && /已丢弃|下载被截断|解析失败/.test(e.message))
				throw e;

			return fs.remove(tmp).catch(function() {})
				.then(function() { return fs.remove(tmpJson).catch(function() {}); })
				.then(function() { throw e; });
		});
};

/*
 * 更新一个规则集：下载 → 校验 → 备份旧文件 → 原子替换。
 * 任何一步失败都不会动到正在使用的文件。
 */
api.updateRuleSet = function(tag) {
	var spec = RULESET_SOURCES[tag];

	if (!spec)
		return Promise.reject(new Error(_('这个规则集不支持自动更新')));

	var dst = api.ruleSetPath(tag);
	var tmp = dst + '.tmp';
	var bak = dst + '.bak';

	return api.downloadRuleSet(tag, tmp).then(function(dl) {
		return api.validateRuleSet(tag, tmp).then(function(v) {
			v.url = dl.url;

			/* 备份旧文件（不存在也无所谓） */
			return api.exec('/bin/mv', [ dst, bak ]).catch(function() { return null; })
				.then(function() { return v; });
		});
	}).then(function(v) {
		return api.exec('/bin/mv', [ tmp, dst ]).then(function(res) {
			if (res.code !== 0) {
				/* 装不进去就把备份恢复回来 */
				return api.exec('/bin/mv', [ bak, dst ]).catch(function() { return null; })
					.then(function() {
						throw new Error(_('替换文件失败') + '：' + core.trimStr(res.stderr || res.stdout));
					});
			}

			return v;
		});
	}).then(function(v) {
		return { tag: tag, size: v.size, rules: v.rules, url: v.url, path: dst };
	}).catch(function(e) {
		/* 兜底清理，避免留下 .tmp */
		return fs.remove(tmp).catch(function() {}).then(function() { throw e; });
	});
};

/* 同 core：必须导出 class，LuCI 会 new 它 */
return baseclass.extend(api);
