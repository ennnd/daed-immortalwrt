/*
 * 用 node 模拟一个最小 LuCI 运行环境（假 DOM / fs / uci / ui），把四个 view 的
 * load()+render() 真跑一遍，并驱动 api 与 view 的写入链路：
 *
 *   status / saveConfig / checkText / resetFactory
 *   enable（含 dnsmasq 接管顺序）/ disable / fetchSubscription / updateRuleSet
 *   saveNode / deleteNode / applyParsed（订阅写入）
 *
 * 这不是浏览器测试，但能抓住"函数名写错、undefined、Promise 链断、成员没同步"
 * 这类致命问题——在没有路由器、没有浏览器的情况下，这是唯一能真跑一遍的办法。
 *
 *   node test/sim.js
 *   SIM_OUT=/tmp/app-written.json node test/sim.js   # 顺便把 UI 最终写出的配置导出
 *
 * 导出的配置可以直接交给 `sing-box check -c` 验 schema（CI 里就是这么做的）。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PKG = path.join(__dirname, '..');
const RES = path.join(PKG, 'htdocs/luci-static/resources');
const REAL_CFG = path.join(PKG, '..', '..', 'newifi3-files/etc/sing-box/config.json');

/* ---------------- 假 DOM ---------------- */
class El {
	constructor(tag, attrs, children) {
		this.tag = tag;
		this.attrs = attrs || {};
		this.children = [];
		this.style = {};
		this.textContent = '';
		this.value = this.attrs.value != null ? this.attrs.value : '';
		this.checked = this.attrs.type === 'checkbox' ? ('checked' in this.attrs) : false;
		this.disabled = false;
		this.classList = { add() {}, remove() {}, contains() { return false; } };
		this._append(children);
	}
	_append(children) {
		if (children == null) return;
		if (Array.isArray(children)) { children.forEach(c => this._append(c)); return; }
		if (children instanceof El) { this.children.push(children); return; }
		this.children.push(String(children));
	}
	appendChild(n) { this.children.push(n); return n; }
	removeChild(n) {
		const i = this.children.indexOf(n);
		if (i >= 0) this.children.splice(i, 1);
		return n;
	}
	get firstChild() { return this.children.length ? this.children[0] : null; }
	querySelector() { return null; }
	setAttribute(k, v) { this.attrs[k] = v; }
	addEventListener() {}
	focus() {}
	blur() {}
}

global.window = { location: { reload() {} } };
global.document = {
	body: new El('body'),
	createElement: t => new El(t),
	querySelector: () => null,
	title: ''
};
global.E = (tag, attrs, children) => new El(tag, attrs, children);
global._ = s => (s == null ? '' : String(s));
global.L = { resource: p => '/luci-static/resources/' + p, isObject: o => o && typeof o === 'object' };
global.confirm = () => true;
global.setTimeout = setTimeout;

/* ---------------- 假 fs / uci / ui ---------------- */
const files = {
	'/etc/sing-box/config.json': fs.readFileSync(REAL_CFG, 'utf8'),
	'/etc/sing-box/subscriptions.json': JSON.stringify({
		subscriptions: [ { url: 'https://example.com/sub', ua: 'v2rayN/6.0', last_update: 1700000000000, count: 6 } ],
		settings: { sync_members: true, ua: 'v2rayN/6.0' }
	}, null, 2),
	'/rom/etc/sing-box/config.json': fs.readFileSync(REAL_CFG, 'utf8')
};
const dirs = { '/etc/sing-box/backup': [
	{ name: 'config-1700000000.json', size: 6000, type: 'file' },
	{ name: 'config-1699990000.json', size: 5900, type: 'file' }
] };
const calls = [];

const fakeFs = {
	read: p => p in files ? Promise.resolve(files[p]) : Promise.reject(new Error('ENOENT ' + p)),
	write: (p, d) => { calls.push([ 'write', p ]); files[p] = String(d); return Promise.resolve(0); },
	remove: p => { calls.push([ 'remove', p ]); delete files[p]; return Promise.resolve(0); },
	list: p => dirs[p] ? Promise.resolve(dirs[p]) : Promise.reject(new Error('ENOENT ' + p)),
	stat: p => (p in files || dirs[p]) ? Promise.resolve({ size: (files[p] || '').length }) : Promise.reject(new Error('ENOENT ' + p)),
	exec: (cmd, args) => {
		calls.push([ 'exec', cmd ].concat(args || []));
		const a = args || [];

		if (cmd === '/usr/bin/sing-box' && a[0] === 'version')
			return Promise.resolve({ code: 0, stdout: 'sing-box version 1.14.3\n', stderr: '' });

		if (cmd === '/usr/bin/sing-box' && a[0] === 'check')
			return Promise.resolve({ code: 0, stdout: '', stderr: '' });

		if (/pidof$/.test(cmd))
			return Promise.resolve({ code: 0, stdout: '1234\n', stderr: '' });

		if (/logread$/.test(cmd))
			return Promise.resolve({ code: 0, stdout:
				'2026-10-28 daemon.warn sing-box: urltest: outbound connection to node1: selected auto -> node1\n', stderr: '' });

		if (/\/ip$/.test(cmd))
			return Promise.resolve({ code: 0, stdout:
				'1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n7: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500\n', stderr: '' });

		if (cmd === '/bin/mv') {
			const [ , , src, dst ] = [ '', '', a[1], a[2] ];
			files[dst] = files[src];
			delete files[src];
			return Promise.resolve({ code: 0, stdout: '', stderr: '' });
		}

		if (/uci$/.test(cmd)) {
			const a0 = a[0] || '';

			/* uci show <pkg>：从 uciData 渲染出真实格式 */
			if (a0 === 'show') {
				return Promise.resolve({ code: 0, stdout: renderUciShow(a[1]), stderr: '' });
			}

			/* uci add firewall zone|forwarding|rule：新建段并返回段名 */
			if (a0 === 'add' && a[1] === 'firewall') {
				const name = 'cfg' + String(++addedCounter).padStart(4, '0');

				if (!uciData.firewall)
					uciData.firewall = {};

				uciData.firewall[name] = {
					'.type': (a[2] === 'zone') ? 'zone' : (a[2] === 'rule' ? 'rule' : 'forwarding')
				};

				return Promise.resolve({ code: 0, stdout: name + '\n', stderr: '' });
			}

			if (a0 === 'set' || a0 === 'add_list') {
				const m = /^(.+?)\.(.+?)\.(.+?)=(.+)$/.exec(a[1] || '');

				if (m) {
					const pkg = m[1], sid = m[2], opt = m[3], val = m[4];

					if (!uciData[pkg])
						uciData[pkg] = {};
					if (!uciData[pkg][sid])
						uciData[pkg][sid] = {};

					if (a0 === 'add_list') {
						const cur = uciData[pkg][sid][opt];

						uciData[pkg][sid][opt] = cur == null ? [ val ] : [].concat(cur, val);
					}
					else
						uciData[pkg][sid][opt] = val;
				}
			}

			return Promise.resolve({ code: 0, stdout: '', stderr: '' });
		}

		if (/uclient-fetch$/.test(cmd)) {
			const out = a[a.indexOf('-O') + 1];
			files[out] = /\.srs$/.test(out)
				? 'x'.repeat(150 * 1024)
				: fs.readFileSync(path.join(PKG, 'test/fixtures/sub-plain.txt'), 'utf8');
			return Promise.resolve({ code: 0, stdout: '', stderr: '' });
		}

		return Promise.resolve({ code: 0, stdout: '', stderr: '' });
	}
};

const uciData = {
	'sing-box': { main: { '.type': 'sing-box', enabled: '1' } },
	dhcp: {
		'@dnsmasq[0]': { '.type': 'dnsmasq', port: '0' },
		lan: { '.type': 'interface', dhcp_option: [ '6,223.5.5.5' ] }
	},
	/*
	 * 防火墙布局刻意做成"修复前"的样子：singbox 区 input=REJECT / forward=DROP，
	 * 且缺 wan->singbox 转发 —— 正是实机上让代理回程被拒、路由器自身出站报
	 * "Operation not permitted" 的那套配置。enable() 必须把它修好。
	 */
	firewall: {
		'@zone[0]': { '.type': 'zone', name: 'lan', network: 'lan' },
		'@zone[1]': { '.type': 'zone', name: 'wan', network: 'wan' },
		'@zone[2]': { '.type': 'zone', name: 'singbox', input: 'REJECT', output: 'ACCEPT', forward: 'DROP', masq: '0', device: 'tun0' },
		'@forwarding[0]': { '.type': 'forwarding', src: 'lan', dest: 'wan' },
		'@forwarding[1]': { '.type': 'forwarding', src: 'lan', dest: 'singbox' }
	}
};

let addedCounter = 0;

/* 把 uciData 渲染成 `uci show <pkg>` 的真实格式 */
function renderUciShow(pkg) {
	const data = uciData[pkg];

	if (!data)
		return '';

	const lines = [];

	for (const sid in data) {
		const sec = data[sid];

		if (sec['.type'])
			lines.push(pkg + '.' + sid + '=' + sec['.type']);

		for (const opt in sec) {
			if (opt === '.type')
				continue;

			const v = sec[opt];

			if (Array.isArray(v))
				v.forEach(x => lines.push(pkg + '.' + sid + '.' + opt + "='" + x + "'"));
			else
				lines.push(pkg + '.' + sid + '.' + opt + "='" + v + "'");
		}
	}

	return lines.join('\n') + '\n';
}

const fakeUci = {
	load: p => Promise.resolve(),
	unload: () => {},
	get: (p, s, o) => {
		const pkg = uciData[p];
		if (!pkg) return null;
		const sec = pkg[s];
		if (!sec) return null;
		return (o == null) ? sec : (sec[o] == null ? null : sec[o]);
	}
};

const fakeUi = {
	showModal: (t, c) => { return new El('div'); },
	hideModal: () => {},
	addNotification: (t, c, cls) => { return new El('div'); }
};

/* ---------------- 模块加载（模拟 LuCI 的 require 指令） ---------------- */
const cache = {};

function modulePath(name) {
	return path.join(RES, name.replace(/\./g, '/') + '.js');
}

/* 模仿 LuCI 的 baseclass：extend() 返回一个真正的 class（不是普通对象），
   require() 会 new 它再返回实例 */
function makeClass(props) {
	function C() {}
	C.prototype = Object.create(null);
	for (const k in props)
		if (Object.prototype.hasOwnProperty.call(props, k))
			C.prototype[k] = props[k];
	return C;
}

const builtins = {
	view: { extend: props => makeClass(props) },
	baseclass: { extend: props => makeClass(props) },
	fs: fakeFs,
	uci: fakeUci,
	ui: fakeUi,
	dom: { create: (t, a, c) => new El(t, a, c) },
	poll: { add: () => {}, stop: () => {} }
};

function load(name) {
	if (cache[name]) return cache[name];
	if (builtins[name]) return (cache[name] = builtins[name]);

	const file = modulePath(name);
	const src = fs.readFileSync(file, 'utf8');
	const re = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([A-Za-z_]\S*))?$/;
	const names = [], args = [];

	src.split('\n').forEach(line => {
		const m = re.exec(line.trim().replace(/^['"]|['"];?$/g, ''));
		if (m) {
			names.push(m[1]);
			args.push(m[2] || m[1].replace(/[^A-Za-z0-9_]/g, '_'));
		}
	});

	const deps = names.map(load);
	const factory = new Function('window', 'document', 'L' + (args.length ? ', ' + args.join(', ') : ''), src);
	const out = factory(global.window, global.document, global.L, ...deps);

	/* 和 LuCI 一样严格：factory 必须返回 class，否则浏览器里就是
	   TypeError: "xxx" factory yields invalid constructor */
	if (typeof out !== 'function')
		throw new Error(name + ' factory yields invalid constructor（必须 return baseclass.extend(...) / view.extend(...)）');

	const instance = new out();
	cache[name] = instance;
	return instance;
}

/* ---------------- 跑起来 ---------------- */
(async () => {
	let ok = 0, bad = 0;

	const check = (label, cond, extra) => {
		if (cond) { ok++; console.log('  ok   ' + label); }
		else { bad++; console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')); }
	};

	// core / api / ui
	const core = load('singbox.core');
	const api = load('singbox.api');
	const sbui = load('singbox.ui');

	console.log('\n[ui helpers]');
	const card = sbui.card('t', [ sbui.table([ 'a' ], [ [ 'x', 'y' ] ]) ]);
	check('card 能创建', card instanceof El);
	check('table 空数组走空文案', sbui.table([ 'a' ], [], 'empty') instanceof El);
	check('fmtBytes', sbui.fmtBytes(2048) === '2.0 KB', sbui.fmtBytes(2048));
	check('fmtTime(0)', sbui.fmtTime(0) === '—');

	console.log('\n[api]');
	const st = await api.status();
	check('status.running', st.running === true);
	check('status.tun 解析出 tun0', st.tun.length === 1 && st.tun[0] === 'tun0', JSON.stringify(st.tun));
	check('status.dns_taken', st.dns_taken === true);
	check('status.version', /1\.14\.3/.test(st.version), st.version);
	check('status.urltest 抓到行', /selected/.test(st.urltest_last));

	const bk = await api.listBackups();
	check('listBackups 两条', bk.length === 2);
	check('listBackups 按时间倒序', bk[0].time > bk[1].time);

	const rc = await api.readConfig();
	check('readConfig 能剥注释解析', rc.cfg && !rc.error, rc.error);
	check('readConfig 认出占位符', /YOUR_/.test(rc.text));

	const saved = await api.saveConfig(rc.cfg, 'test');
	check('saveConfig 走完（备份→check→mv→restart）', saved && saved.restarted === true);
	check('saveConfig 写了备份', calls.some(c => c[0] === 'write' && /backup\/config-\d+\.json/.test(c[1])));
	check('saveConfig 调用了 mv', calls.some(c => c[0] === 'exec' && c[1] === '/bin/mv'));

	const chk = await api.checkText('{}');
	check('checkText 返回 code', chk.code === 0);

	const rf = await api.resetFactory();
	check('resetFactory 从 /rom 读并保存', rf && rf.restarted === true);

	/* 启用需要没有占位符的配置：把模板里的 YOUR_* 换掉 */
	files['/etc/sing-box/config.json'] = files['/etc/sing-box/config.json']
		.split('YOUR_SERVER').join('example.com')
		.split('YOUR_UUID').join('11111111-2222-3333-4444-555555555555')
		.split('YOUR_REALITY_PUBLIC_KEY').join('AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04')
		.split('YOUR_REALITY_SHORT_ID').join('ab12')
		.split('YOUR_SNI').join('www.bing.com')
		.split('YOUR_PASSWORD').join('pw');

	/* 只看 enable() 之后产生的调用（之前 saveConfig 也会重启 sing-box） */
	const mark = calls.length;
	const en = await api.enable();
	check('enable 成功', en.running === true);

	const enCalls = calls.slice(mark);

	/* 找出某条 uci 调用：uciCall('set', 'xxx') */
	const uciCall = (verb, needle) => enCalls.some(c =>
		c[0] === 'exec' && /uci$/.test(c[1]) && (c[2] || '') === verb &&
		String(c[3] || '').indexOf(needle) >= 0);

	/* --- DNS：绝不能再做"DNS 接管"，必须换公网上游 --- */
	check('enable 没有把 dnsmasq port 设成 0（旧版接管会打死整网 DNS）',
		!uciCall('set', 'dnsmasq[0].port=0'));
	check('enable 没有给 LAN 下发强制 DNS',
		!uciCall('add_list', 'dhcp.lan.dhcp_option'));
	check('enable 清掉了旧版留下的 LAN 强制 DNS',
		enCalls.some(c => c[0] === 'exec' && /uci$/.test(c[1]) &&
			c.slice(2).indexOf('dhcp.lan.dhcp_option') >= 0));
	check('enable 把 dnsmasq port 复位成 53', uciCall('set', 'dhcp.@dnsmasq[0].port=53'));
	check('enable 设置了 noresolv=1', uciCall('set', 'dhcp.@dnsmasq[0].noresolv=1'));
	check('enable 把上游换成公网解析器 223.5.5.5',
		uciCall('add_list', 'dhcp.@dnsmasq[0].server=223.5.5.5'));
	check('enable 把上游换成公网解析器 119.29.29.29',
		uciCall('add_list', 'dhcp.@dnsmasq[0].server=119.29.29.29'));

	/* --- 防火墙区：必须建好并放行 tun0 回程 --- */
	check('enable 把 singbox 区 input 改成 ACCEPT', uciCall('set', 'firewall.@zone[2].input=ACCEPT'));
	check('enable 把 singbox 区 forward 改成 ACCEPT', uciCall('set', 'firewall.@zone[2].forward=ACCEPT'));
	check('enable 关闭 singbox 区 masquerade', uciCall('set', 'firewall.@zone[2].masq=0'));
	check('enable 补上了缺失的 wan->singbox 转发',
		enCalls.some(c => c[0] === 'exec' && (c[2] || '') === 'add' &&
			(c[3] || '') === 'firewall' && (c[4] || '') === 'forwarding'));
	check('enable 调用了 fw4 reload 让规则生效',
		enCalls.some(c => c[0] === 'exec' && /fw4$/.test(c[1]) && (c[2] || '') === 'reload'));

	/* --- IPv6 绕过防护：TUN 只有 IPv4，LAN 的 IPv6 出网必须被挡 --- */
	check('enable 建了 IPv6 防护规则',
		enCalls.some(c => c[0] === 'exec' && (c[2] || '') === 'add' &&
			(c[3] || '') === 'firewall' && (c[4] || '') === 'rule'));
	check('enable 把 IPv6 防护规则的 family 设为 ipv6',
		uciCall('set', '.family=ipv6'));
	check('enable 把 IPv6 防护规则的目标设为 REJECT（让客户端快速回退 IPv4）',
		uciCall('set', '.target=REJECT'));
	check('enable 把 IPv6 防护规则的 src 设为 lan',
		uciCall('set', '.src=lan'));
	check('enable 把 IPv6 防护规则的 dest 设为 wan',
		uciCall('set', '.dest=wan'));

	/* --- 顺序：fw4 reload 必须早于 sing-box restart，否则 TUN 规则被冲掉 --- */
	const idxFw4 = enCalls.findIndex(c => c[0] === 'exec' && /fw4$/.test(c[1]));
	const idxRestart = enCalls.findIndex(c => c[0] === 'exec' &&
		c[1] === '/etc/init.d/sing-box' && (c[2] || '') === 'restart');
	check('enable 顺序正确：fw4 reload 在 sing-box restart 之前',
		idxFw4 >= 0 && idxRestart >= 0 && idxFw4 < idxRestart,
		'fw4=' + idxFw4 + ' restart=' + idxRestart);

	check('enable 前确保 conffile 已设置（救回缺 conffile 的固件）',
		uciData['sing-box']['main']['conffile'] === '/etc/sing-box/config.json');

	/* --- enable 之后状态自检 --- */
	const st2 = await api.status();
	check('enable 后防火墙区判定为正常', st2.fw_zone_ok === true, JSON.stringify(st2.fw_zone_problems));
	check('enable 后 DNS 判定为经 sing-box', st2.dns_via_singbox === true,
		JSON.stringify({ noresolv: st2.dns_noresolv, upstream: st2.dns_upstream }));
	check('enable 后不再判定为旧版接管', st2.dns_taken === false);
	check('enable 后 IPv6 防护判定为就绪', st2.ipv6_block_ok === true,
		JSON.stringify(st2.ipv6_block_problems));

	const dis = await api.disable();
	check('disable 成功', dis.running === false);

	const txt = await api.fetchSubscription('https://example.com/sub', 'v2rayN/6.0');
	check('fetchSubscription 拿到内容', /vmess:\/\//.test(txt));
	const parsed = core.parseSubscription(txt);
	check('fetch 的内容可解析', parsed.nodes.length === 6);

	const rs = await api.updateRuleSet('geosite-cn');
	check('updateRuleSet 返回大小', rs.size > 0, JSON.stringify(rs));

	console.log('\n[views]');
	for (const v of [ 'overview', 'nodes', 'routing', 'advanced' ]) {
		const mod = load('view.singbox.' + v);
		const data = await mod.load();
		const node = mod.render(data);
		check(v + '.load+render', node instanceof El && node.children.length > 0);
	}

	console.log('\n[nodes 写入链路]');
	const nodesView = load('view.singbox.nodes');
	await nodesView.load();
	const fakeF = {
		tag: { value: '手工节点' }, type: { value: 'vless' }, server: { value: 'manual.example.com' },
		port: { value: '443' }, uuid: { value: '99999999-1111-2222-3333-444444444444' },
		flow: { value: 'xtls-rprx-vision' }, security: { value: 'reality' },
		sni: { value: 'www.bing.com' }, fp: { value: 'chrome' },
		pbk: { value: 'AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04' }, sid: { value: 'ab12' },
		insecure: { checked: false }, obfs: { value: '' }, method: { value: '' }, password: { value: '' }
	};
	await nodesView.saveNode(fakeF, null);
	let after = core.parseJsonc(files['/etc/sing-box/config.json']);
	const added = after.outbounds.filter(o => o.tag === '手工节点')[0];
	check('saveNode 写入节点', !!added && added.type === 'vless' && added.tls.reality.public_key.length > 0);
	check('saveNode 同步进 selector', after.outbounds.filter(o => o.tag === 'proxy')[0].outbounds.indexOf('手工节点') >= 0);
	check('saveNode 同步进 urltest', after.outbounds.filter(o => o.tag === 'auto')[0].outbounds.indexOf('手工节点') >= 0);
	await nodesView.deleteNode('手工节点');
	after = core.parseJsonc(files['/etc/sing-box/config.json']);
	check('deleteNode 删掉节点', !after.outbounds.some(o => o.tag === '手工节点'));
	await nodesView.applyParsed(0, parsed, true);
	after = core.parseJsonc(files['/etc/sing-box/config.json']);
	check('applyParsed 写入订阅节点', after.outbounds.some(o => o.tag === 'Hy2'));
	/* 模拟环境里演示节点已被填成合法值，所以这里验证的是"不会误删用户已填的节点" */
	check('applyParsed 不误删已填写的节点', after.outbounds.some(o => o.tag === 'node1'));
	check('applyParsed 后不再有占位符', core.scanPlaceholders(after).length === 0);
	check('applyParsed 记录 last_update', nodesView.data.subs.subscriptions[0].count === 6);

	const outFile = process.env.SIM_OUT ||
		path.join(require('os').tmpdir(), 'luci-app-singbox-app-written.json');

	fs.writeFileSync(outFile, files['/etc/sing-box/config.json']);
	console.log('UI 最终写出的配置: ' + outFile);
	console.log('\npassed: ' + ok + ', failed: ' + bad);
	process.exit(bad ? 1 : 0);
})().catch(e => {
	console.error('\nHARNESS CRASH:', e && e.stack || e);
	process.exit(1);
});
