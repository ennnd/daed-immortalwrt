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

/* rpcd 的 file read 上限是 256KB（RPC_FILE_MAX_SIZE），留点余量 */
var MAX_SUB = 200 * 1024;
var MAX_BAK = 5;

var RULESET_URL = {
	'geosite-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
	'geoip-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs'
};

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
				var msg = core.trimStr((res.stderr || '') + '\n' + (res.stdout || ''));

				throw new Error(msg || _('sing-box check 失败'));
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
		api.uciGet('sing-box', 'main', 'enabled')
	]).then(function(r) {
		var opts = Array.isArray(r[5]) ? r[5] : (r[5] ? [ r[5] ] : []);
		var dnsTaken = (String(r[4]) === '0' && opts.indexOf('6,223.5.5.5') >= 0);

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
			dns_taken: dnsTaken,
			uci_enabled: String(r[6]) === '1',
			urltest_last: selected
		};
	});
};

/* 启用：完全按 /usr/bin/singbox-on 的顺序，失败回滚，绝不先动 dnsmasq */
api.enable = function() {
	var self = api;

	return self.readConfig().then(function(cfgres) {
		if (/"YOUR_/.test(cfgres.text || ''))
			throw new Error(_('配置里还有 YOUR_* 占位符，请先填好节点再启用'));

		if (cfgres.error)
			throw new Error(_('配置不是合法 JSON') + ': ' + cfgres.error);

		return self.exec('/usr/bin/sing-box', [ 'check', '-c', CFG ]);
	}).then(function(res) {
		if (res.code !== 0)
			throw new Error(core.trimStr(res.stderr || res.stdout) || _('sing-box check 失败'));

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
			/* 回滚：把 enabled 关掉并停服务，dnsmasq 保持原样 */
			return self.uci([ 'set', 'sing-box.main.enabled=0' ])
				.then(function() { return self.uci([ 'commit', 'sing-box' ]); })
				.then(function() { return self.exec('/etc/init.d/sing-box', [ 'stop' ]); })
				.then(function() { return self.logTail(20); })
				.then(function(log) {
					throw new Error(_('sing-box 启动失败，已回滚，dnsmasq 未改动') + '\n' + log);
				});
		}

		/* 成功之后才接管 DNS：dnsmasq 只做 DHCP，LAN DNS 指向 223.5.5.5 */
		return self.uci([ 'set', 'dhcp.@dnsmasq[0].port=0' ])
			.then(function() { return self.uci([ '-q', 'delete', 'dhcp.lan.dhcp_option' ]); })
			.then(function() { return self.uci([ 'add_list', 'dhcp.lan.dhcp_option=6,223.5.5.5' ]); })
			.then(function() { return self.uci([ 'commit', 'dhcp' ]); })
			.then(function() { return self.exec('/etc/init.d/dnsmasq', [ 'restart' ]); })
			.then(function() {
				return { running: true, pid: st.pid };
			});
	});
};

api.disable = function() {
	var self = api;

	return self.exec('/etc/init.d/sing-box', [ 'stop' ])
		.then(function() { return self.uci([ 'set', 'sing-box.main.enabled=0' ]); })
		.then(function() { return self.uci([ 'commit', 'sing-box' ]); })
		.then(function() { return self.uci([ 'set', 'dhcp.@dnsmasq[0].port=53' ]); })
		.then(function() { return self.uci([ '-q', 'delete', 'dhcp.lan.dhcp_option' ]); })
		.then(function() { return self.uci([ 'commit', 'dhcp' ]); })
		.then(function() { return self.exec('/etc/init.d/dnsmasq', [ 'restart' ]); })
		.then(function() { return { running: false }; });
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

api.updateRuleSet = function(tag) {
	var url = RULESET_URL[tag];

	if (!url)
		return Promise.reject(new Error(_('这个规则集不支持自动更新')));

	var dst = '/etc/sing-box/rule-set/' + tag + '.srs';

	return api.fetch([ '-q', '-O', dst, '--timeout=20', url ])
		.then(function(res) {
			if (res.code !== 0)
				throw new Error(_('下载失败') + ': ' + core.trimStr(res.stderr || res.stdout));

			return fs.stat(dst).catch(function() { return null; });
		}).then(function(st) {
			var size = (st && st.size) ? st.size : 0;

			if (size < 100 * 1024) {
				fs.remove(dst).catch(function() {});
				throw new Error(_('下载到的文件太小（') + size + _(' 字节），已删除'));
			}

			return { tag: tag, size: size };
		});
};

/* 同 core：必须导出 class，LuCI 会 new 它 */
return baseclass.extend(api);
