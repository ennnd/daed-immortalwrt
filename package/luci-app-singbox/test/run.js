/*
 * luci-app-singbox 纯逻辑单测（node 直接跑）
 *
 *   node test/run.js
 *
 * CI 里也可以跑（Build 之后，node 在 ubuntu runner 上本来就有）。
 * 覆盖：JSONC 剥注释 / base64 / URI 解析 / 订阅三格式 / 合并与 members 修正。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*
 * 按 LuCI 的方式加载模块：扫描文件头的 require 指令，把源码包成
 * function(window, document, L<deps>) 执行，然后"把返回的 class new 出来"。
 * 最后一步是关键——LuCI 的 require() 会 new 它再返回实例，
 * 直接 return 普通对象会在浏览器里报 "factory yields invalid constructor"。
 */
function makeBaseClass() {
	function Base() {}
	Base.extend = function(props) {
		function C() {}
		C.prototype = Object.create(Base.prototype);
		for (const k in props)
			if (Object.prototype.hasOwnProperty.call(props, k))
				C.prototype[k] = props[k];
		return C;
	};
	return Base;
}

const BaseClass = makeBaseClass();

function loadModule(relPath) {
	const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
	const re = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([A-Za-z_]\S*))?$/;
	const deps = [], names = [];

	src.split('\n').forEach(line => {
		const m = re.exec(line.trim().replace(/^['"]|['"];?$/g, ''));
		if (m) {
			deps.push(m[1]);
			names.push(m[2] || m[1].replace(/[^A-Za-z0-9_]/g, '_'));
		}
	});

	const factory = new Function('window', 'document', 'L' + (names.length ? ', ' + names.join(', ') : ''), src);
	const args = deps.map(d => {
		if (d === 'baseclass') return BaseClass;
		throw new Error(relPath + ' 依赖了 ' + d + '，单测里没有对应实现');
	});
	const ret = factory(null, null, null, ...args);

	if (typeof ret !== 'function')
		throw new Error(relPath + ' factory 没有返回 class（LuCI 会报 factory yields invalid constructor）');

	return new ret();
}

function loadCore() {
	return loadModule('htdocs/luci-static/resources/singbox/core.js');
}

const core = loadCore();

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
	if (cond) { pass++; return; }
	fail++;
	failures.push(name + (detail ? ' → ' + detail : ''));
}

function eq(name, actual, expected) {
	ok(name, JSON.stringify(actual) === JSON.stringify(expected),
		'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

ok('core.js 导出的是 class（LuCI 的 require 会 new 它）', typeof core.parseJsonc === 'function');

/* ---------- 1. JSONC ---------- */

const realCfgPath = path.join(ROOT, '../../newifi3-files/etc/sing-box/config.json');
const realCfgText = fs.existsSync(realCfgPath) ? fs.readFileSync(realCfgPath, 'utf8') : '';

if (realCfgText) {
	let parsed = null, err = null;
	try { parsed = core.parseJsonc(realCfgText); } catch (e) { err = e.message; }

	ok('真实 config.json 剥注释后可解析', parsed != null, err);
	ok('剥注释后仍是对象', parsed && typeof parsed === 'object');
	eq('字符串里的 // 没被当注释吃掉',
		parsed && parsed.outbounds && parsed.outbounds[1] && parsed.outbounds[1].url,
		'https://www.gstatic.com/generate_204');
	eq('rule_set 路径完整',
		parsed && parsed.route && parsed.route.rule_set[0].path,
		'/etc/sing-box/rule-set/geosite-cn.srs');
	ok('嵌套 tls 结构在', parsed && parsed.outbounds[2] && parsed.outbounds[2].tls
		&& parsed.outbounds[2].tls.reality && parsed.outbounds[2].tls.reality.public_key === 'YOUR_REALITY_PUBLIC_KEY');
}

eq('纯注释 → 空', core.trimStr(core.stripJsonc('// a\n/* b */\n')), '');
eq('尾逗号被去掉',
	core.stripJsonc('{"a":1,"b":[1,2,],}'), '{"a":1,"b":[1,2]}');
eq('注释在字符串后不误伤',
	core.stripJsonc('{"u":"x // y"} // tail'), '{"u":"x // y"} ');
eq('转义引号不被当字符串结束',
	core.stripJsonc('{"u":"a\\"//b"}'), '{"u":"a\\"//b"}');

/* ---------- 2. base64 ---------- */

const zh = '测试节点·中文 tag 123';
const zhB64 = Buffer.from(zh, 'utf8').toString('base64');
eq('base64 解码（中文）', core.b64DecodeString(zhB64), zh);
eq('base64 URL-safe',
	core.b64DecodeString(zhB64.replace(/\+/g, '-').replace(/\//g, '_')), zh);
eq('base64 无 padding',
	core.b64DecodeString(zhB64.replace(/=+$/, '')), zh);
eq('base64 带换行', core.b64DecodeString(zhB64.slice(0, 8) + '\n' + zhB64.slice(8)), zh);

/* ---------- 3. 订阅：明文 / base64 / JSON ---------- */

const plain = fs.readFileSync(path.join(__dirname, 'fixtures/sub-plain.txt'), 'utf8');
const b64sub = fs.readFileSync(path.join(__dirname, 'fixtures/sub-base64.txt'), 'utf8');
const jsonsub = fs.readFileSync(path.join(__dirname, 'fixtures/sub-json.json'), 'utf8');

const rPlain = core.parseSubscription(plain);
eq('明文订阅 format', rPlain.format, 'plain');
eq('明文订阅节点数', rPlain.nodes.length, 6);
eq('明文订阅跳过数', rPlain.skipped.length, 3);
eq('跳过原因集合', rPlain.skipped.map(s => s.reason).sort(), [ 'grpc', 'plugin', 'ssr' ]);

const tags = rPlain.nodes.map(n => n.tag);
eq('节点 tag 顺序', tags, [ 'VMess-WS', 'VLESS-Reality', 'Trojan-WS', 'SS-AEAD', 'Hy2', 'TUIC' ]);

const vm = rPlain.nodes[0];
eq('vmess 类型', vm.type, 'vmess');
eq('vmess server', vm.server, 'vm.example.com');
eq('vmess port', vm.server_port, 443);
eq('vmess alter_id', vm.alter_id, 0);
eq('vmess ws path', vm.transport && vm.transport.path, '/ray');
eq('vmess ws Host', vm.transport && vm.transport.headers && vm.transport.headers.Host, 'vm.example.com');
eq('vmess utls fp', vm.tls && vm.tls.utls && vm.tls.utls.fingerprint, 'chrome');

const vl = rPlain.nodes[1];
eq('vless flow', vl.flow, 'xtls-rprx-vision');
eq('vless reality 公钥', vl.tls.reality.public_key, 'AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04');
eq('vless reality short_id', vl.tls.reality.short_id, 'ab12');
eq('vless sni', vl.tls.server_name, 'www.bing.com');

const tr = rPlain.nodes[2];
eq('trojan 密码', tr.password, 'pass123');
eq('trojan ws path 解码', tr.transport && tr.transport.path, '/ws');

const ss = rPlain.nodes[3];
eq('ss method', ss.method, 'aes-256-gcm');
eq('ss 密码', ss.password, 'pass456');

const hy = rPlain.nodes[4];
eq('hy2 obfs', hy.obfs && hy.obfs.type, 'salamander');
eq('hy2 obfs 密码', hy.obfs && hy.obfs.password, 'obfspass');

const tu = rPlain.nodes[5];
eq('tuic uuid', tu.uuid, '99999999-8888-7777-6666-555555555555');
eq('tuic 拥塞控制', tu.congestion_control, 'bbr');
eq('tuic alpn', tu.tls.alpn, [ 'h3' ]);

const rB64 = core.parseSubscription(b64sub);
eq('base64 订阅 format', rB64.format, 'base64');
eq('base64 订阅节点数', rB64.nodes.length, 6);
eq('base64 与明文结果一致', rB64.nodes.map(n => n.tag), tags);

const rJson = core.parseSubscription(jsonsub);
eq('JSON 订阅 format', rJson.format, 'json');
eq('JSON 订阅只取代理出站', rJson.nodes.map(n => n.tag), [ 'JSON-Node', 'JSON-SS' ]);

const rEmpty = core.parseSubscription('   \n\n ');
eq('空订阅', rEmpty.nodes.length, 0);
eq('乱码订阅不崩', core.parseSubscription('这不是订阅也不是 base64 !!!').nodes.length, 0);

const sum = core.summarizeSkipped(rPlain.skipped);
ok('跳过汇总按数量降序', sum.length === 3 && sum.every(s => s.count === 1));
ok('跳过原因是中文', /gRPC/.test(core.skipReasonText('grpc')));

/* ---------- 4. 合并 / members 修正 ---------- */

const cfg = core.parseJsonc(realCfgText);
const merged = core.mergeNodes(cfg, rPlain.nodes, { syncMembers: true });

eq('新增节点数', merged.added.length, 6);
eq('覆盖节点数', merged.replaced.length, 0);

const sel = cfg.outbounds.filter(o => o.tag === 'proxy')[0];
const urltest = cfg.outbounds.filter(o => o.tag === 'auto')[0];
ok('selector 里加进了新节点', merged.added.every(t => sel.outbounds.indexOf(t) >= 0));
ok('urltest 里加进了新节点', merged.added.every(t => urltest.outbounds.indexOf(t) >= 0));
eq('selector default 仍有效', sel.default, 'auto');

/* 悬空成员 + 失效 default */
const cfg2 = core.parseJsonc(realCfgText);
cfg2.outbounds.push({ type: 'selector', tag: 'bad', outbounds: [ 'ghost', 'node1' ], default: 'nothere' });
const fixes = core.normalizeMembers(cfg2);
const bad = cfg2.outbounds.filter(o => o.tag === 'bad')[0];
eq('悬空成员被移除', bad.outbounds, [ 'node1' ]);
eq('失效 default 被修正', bad.default, 'node1');
ok('修正动作有记录', fixes.length >= 2);

/* 删除节点 */
const cfg3 = core.parseJsonc(realCfgText);
const del = core.removeOutbound(cfg3, 'node2');
ok('删除返回 removed', del.removed === true);
ok('delete 后 auto 里没有 node2',
	cfg3.outbounds.filter(o => o.tag === 'auto')[0].outbounds.indexOf('node2') < 0);
const del2 = core.removeOutbound(cfg3, 'direct');
ok('direct 不允许删除', del2.removed === false);

/* ---------- 4b. selector 信息抽取 + 切换 default（节点选择下拉框） ---------- */

const selCfg = core.parseJsonc(realCfgText);
const info = core.selectorInfo(selCfg, 'proxy');
ok('找到 proxy selector', info != null);
eq('proxy 候选含 auto/node1/2/3',
	info.outbounds, [ 'auto', 'node1', 'node2', 'node3' ]);
eq('默认是 auto', info.current, 'auto');

/* 切到 node1：default 被改，且只动了 proxy，不影响 auto 的成员 */
core.applySelectorDefault(selCfg, 'proxy', 'node1');
eq('proxy.default 变 node1',
	selCfg.outbounds.filter(o => o.tag === 'proxy')[0].default, 'node1');
ok('auto 的成员没被改动',
	selCfg.outbounds.filter(o => o.tag === 'auto')[0].outbounds.join(',') === 'node1,node2,node3');

/* 不在成员里应抛错 */
let threw = false;
try { core.applySelectorDefault(selCfg, 'proxy', 'ghost'); } catch (e) { threw = true; }
ok('切换到不存在的成员会抛错', threw);

/* 没有 proxy 时返回 null（UI 据此隐藏控件） */
const noProxy = { outbounds: [ { type: 'vless', tag: 'node1' } ] };
eq('无 proxy selector → null', core.selectorInfo(noProxy, 'proxy'), null);

/* tag 去重 */
const dup = [
	{ type: 'vless', tag: '同名' }, { type: 'vless', tag: '同名' }, { type: 'vless', tag: '' }
];
core.assignTags(dup);
eq('tag 去重', dup.map(n => n.tag), [ '同名', '同名-2', 'node-3' ]);

/* ---------- 5. 字段校验与错误诊断（实机报错的回归测试） ---------- */

/* 2026-10-28 设备上真实出现的报错：
   FATAL[0000] initialize outbound[2]: invalid public_key
   对应的就是出厂模板第三个 outbound（node1）的 Reality 占位符 */
ok('43 位 base64url 公钥通过', core.realityKeyOk('AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04'));
ok('占位符不是合法公钥', !core.realityKeyOk('YOUR_REALITY_PUBLIC_KEY'));
ok('带 padding 的公钥被拒', !core.realityKeyOk('AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04='));
ok('42 位被拒', !core.realityKeyOk('AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ0'));

ok('short_id 十六进制通过', core.shortIdOk('ab12cd34'));
ok('short_id 允许为空', core.shortIdOk(''));
ok('short_id 奇数位被拒', !core.shortIdOk('abc'));
ok('short_id 非十六进制被拒', !core.shortIdOk('zzzz'));

const diag = core.explainCheckError(realCfgText, 'FATAL[0000] initialize outbound[2]: invalid public_key');
eq('诊断定位到 outbound 下标', diag.index, 2);
eq('诊断带出 tag', diag.tag, 'node1');
eq('诊断带出类型', diag.type, 'vless');
ok('诊断给出中文提示', /43 位 base64url/.test(diag.hint), diag.hint);

const diagDup = core.explainCheckError(realCfgText,
	'FATAL[0000] decode config at /tmp/x.json: duplicate outbound/endpoint tag: node2');
ok('重名 tag 有提示', /tag 重名/.test(diagDup.hint), diagDup.hint);
eq('重名时不误报下标', diagDup.index, -1);

const ph = core.scanPlaceholders(core.parseJsonc(realCfgText));
eq('模板里 3 个演示节点', ph.length, 3);
ok('占位符字段被列出', ph[0].fields.indexOf('YOUR_REALITY_PUBLIC_KEY') >= 0, JSON.stringify(ph[0].fields));
ok('占位符文本带 tag', /node1\(/.test(core.placeholderText(ph)), core.placeholderText(ph));

/* 订阅里 pbk 被截断的节点应被跳过，而不是让整份配置 check 失败 */
const badPbkUri = 'vless://11111111-2222-3333-4444-555555555555@a.example.com:443'
	+ '?security=reality&sni=www.bing.com&fp=chrome&pbk=tooshort&sid=ab12&type=tcp#坏公钥';
const badPbk = core.parseUri(badPbkUri);
eq('坏公钥节点被跳过', badPbk.skip, 'bad-reality-key');
ok('跳过原因可读', /43 位/.test(core.skipReasonText('bad-reality-key')));

const badSidUri = 'vless://11111111-2222-3333-4444-555555555555@a.example.com:443'
	+ '?security=reality&sni=www.bing.com&fp=chrome'
	+ '&pbk=AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04&sid=zz&type=tcp#坏shortid';
eq('坏 short_id 节点被跳过', core.parseUri(badSidUri).skip, 'bad-short-id');

/* 删光所有节点后，selector/urltest 必须留 direct，否则 sing-box 报 missing tags */
const emptyCfg = core.parseJsonc(realCfgText);
core.scanPlaceholders(emptyCfg).forEach(p => core.removeOutbound(emptyCfg, p.tag));
const emptyAuto = emptyCfg.outbounds.filter(o => o.tag === 'auto')[0];
const emptyProxy = emptyCfg.outbounds.filter(o => o.tag === 'proxy')[0];
eq('空 urltest 回落到 direct', emptyAuto.outbounds, [ 'direct' ]);
eq('空 selector 回落到 auto', emptyProxy.outbounds, [ 'auto' ]);
ok('missing tags 有中文提示',
	/添加节点/.test(core.explainCheckError(realCfgText, 'FATAL[0000] initialize outbound[1]: missing tags').hint));

/* 订阅导入时清掉未填写的演示节点（与 nodes.js applyParsed 的清理逻辑一致） */
const importCfg = core.parseJsonc(realCfgText);
core.mergeNodes(importCfg, rPlain.nodes, { syncMembers: true });
core.scanPlaceholders(importCfg).filter(p => p.where === 'outbound' && p.tag)
	.forEach(p => core.removeOutbound(importCfg, p.tag));
core.normalizeMembers(importCfg);
eq('导入后演示节点被清干净', core.scanPlaceholders(importCfg).length, 0);
ok('导入后订阅节点还在', importCfg.outbounds.some(o => o.tag === 'Hy2'));
ok('导入后没有空组', importCfg.outbounds.filter(o => o.type === 'selector' || o.type === 'urltest')
	.every(o => o.outbounds.length > 0));

/* ---------- 5b. uci show 解析 / 防火墙区检查 / DNS 上游判定 ---------- */

/*
 * 这组是"开了 sing-box 国外全挂"那类故障的回归测试：
 * 面板与命令行都要靠这几个纯函数判断防火墙区和 DNS 上游是否正确。
 */

const FW_DUMP = [
	"firewall.@zone[0]=zone",
	"firewall.@zone[0].name='lan'",
	"firewall.@zone[0].network='lan'",
	"firewall.@zone[1]=zone",
	"firewall.@zone[1].name='wan'",
	"firewall.@zone[1].network='wan'",
	"firewall.@zone[2]=zone",
	"firewall.@zone[2].name='singbox'",
	"firewall.@zone[2].input='REJECT'",
	"firewall.@zone[2].output='ACCEPT'",
	"firewall.@zone[2].forward='DROP'",
	"firewall.@zone[2].masq='0'",
	"firewall.@zone[2].device='tun0'",
	"firewall.@forwarding[0]=forwarding",
	"firewall.@forwarding[0].src='lan'",
	"firewall.@forwarding[0].dest='wan'",
	"firewall.@forwarding[1]=forwarding",
	"firewall.@forwarding[1].src='lan'",
	"firewall.@forwarding[1].dest='singbox'"
].join('\n');

const fw = core.parseUciShow(FW_DUMP, 'firewall');

ok('parseUciShow 认出 singbox 区', core.uciFindZone(fw, 'singbox') === '@zone[2]', core.uciFindZone(fw, 'singbox'));
ok('parseUciShow 认出 lan->singbox 转发', core.uciFindForwarding(fw, 'lan', 'singbox') === '@forwarding[1]');
ok('parseUciShow 认出 wan->singbox 转发缺失', core.uciFindForwarding(fw, 'wan', 'singbox') === null);
ok('uciListHas 认单值', core.uciListHas(fw['@zone[2]'].device, 'tun0') === true);
ok('uciListHas 认多值', core.uciListHas([ 'tun0', 'utun' ], 'tun0') === true);
ok('uciListHas 拒错值', core.uciListHas(fw['@zone[2]'].device, 'wan') === false);

const zs = core.uciZoneStatus(fw);
ok('uciZoneStatus 认出 input=REJECT', zs.ok === false && zs.problems.indexOf('input') >= 0, JSON.stringify(zs.problems));
ok('uciZoneStatus 认出 forward=DROP', zs.problems.indexOf('forward') >= 0, JSON.stringify(zs.problems));
/* ---------- 缓存自检（LuCI ?v= 不随内容变，热部署后浏览器仍用旧 JS） ---------- */
ok('core 暴露 BUILD_ID', typeof core.BUILD_ID === 'string' && core.BUILD_ID.length > 0);
ok('core 暴露 VER_PATH', typeof core.VER_PATH === 'string' && core.VER_PATH.indexOf('core.ver.js') > 0);
ok('core 暴露 checkStaleBuild 函数', typeof core.checkStaleBuild === 'function');
ok('core 暴露 fetchServerBuildId 函数', typeof core.fetchServerBuildId === 'function');
ok('BUILD_ID 格式为日期+序号', /^\d{4}-\d{2}-\d{2}\.\d+$/.test(core.BUILD_ID), core.BUILD_ID);

ok('uciZoneStatus 不再要求 wan->singbox 转发（该转发是多余的）',
	zs.problems.indexOf('wan-forward') < 0, JSON.stringify(zs.problems));
ok('uciZoneStatus 不误报 masq=0', zs.problems.indexOf('masq') < 0, JSON.stringify(zs.problems));
ok('fwProblemText 出中文说明', /ACCEPT/.test(core.fwProblemText(zs.problems)));

const fwGood = core.parseUciShow([
	"firewall.cfg0001=zone",
	"firewall.cfg0001.name='singbox'",
	"firewall.cfg0001.input='ACCEPT'",
	"firewall.cfg0001.output='ACCEPT'",
	"firewall.cfg0001.forward='ACCEPT'",
	"firewall.cfg0001.masq='0'",
	"firewall.cfg0001.device='tun0'",
	"firewall.cfg0002=forwarding",
	"firewall.cfg0002.src='lan'",
	"firewall.cfg0002.dest='singbox'",
	"firewall.cfg0003=forwarding",
	"firewall.cfg0003.src='wan'",
	"firewall.cfg0003.dest='singbox'"
].join('\n'), 'firewall');

ok('uciFindZone 支持命名段(cfgXXXX)', core.uciFindZone(fwGood, 'singbox') === 'cfg0001');
ok('uciZoneStatus 全对时 ok', core.uciZoneStatus(fwGood).ok === true, JSON.stringify(core.uciZoneStatus(fwGood).problems));
ok('parseUciShow 多值选项收成数组',
	Array.isArray(core.parseUciShow("firewall.@zone[2].device='tun0'\nfirewall.@zone[2].device='utun'", 'firewall')['@zone[2]'].device));
ok('parseUciShow 忽略别的包', core.parseUciShow("dhcp.lan.proto='static'", 'firewall').lan === undefined);

/* IPv6 绕过防护：TUN 只有 IPv4，LAN 的 IPv6 若放行出 WAN 就绕过代理泄漏真实 IP */
const v6Missing = core.parseUciShow([
	"firewall.@zone[2]=zone",
	"firewall.@zone[2].name='singbox'"
].join('\n'), 'firewall');

ok('uciFindIpv6BlockRule 找不到时返回 null', core.uciFindIpv6BlockRule(v6Missing) === null);
ok('uciIpv6BlockStatus 认出缺规则', core.uciIpv6BlockStatus(v6Missing).ok === false &&
	core.uciIpv6BlockStatus(v6Missing).problems.indexOf('no-rule') >= 0);

const v6Bad = core.parseUciShow([
	"firewall.cfg9001=rule",
	"firewall.cfg9001.name='Block-LAN-IPv6-Egress'",
	"firewall.cfg9001.src='lan'",
	"firewall.cfg9001.dest='wan'",
	"firewall.cfg9001.family='ipv4'",
	"firewall.cfg9001.proto='all'",
	"firewall.cfg9001.target='DROP'"
].join('\n'), 'firewall');

const v6BadSt = core.uciIpv6BlockStatus(v6Bad);
ok('uciFindIpv6BlockRule 按名字找到规则', core.uciFindIpv6BlockRule(v6Bad) === 'cfg9001');
ok('uciIpv6BlockStatus 认出 family 不是 ipv6', v6BadSt.problems.indexOf('family') >= 0, JSON.stringify(v6BadSt.problems));
ok('uciIpv6BlockStatus 认出 DROP（应用 REJECT 让客户端快速回退）', v6BadSt.problems.indexOf('drop') >= 0, JSON.stringify(v6BadSt.problems));

const v6Good = core.parseUciShow([
	"firewall.cfg9002=rule",
	"firewall.cfg9002.name='Block-LAN-IPv6-Egress'",
	"firewall.cfg9002.src='lan'",
	"firewall.cfg9002.dest='wan'",
	"firewall.cfg9002.family='ipv6'",
	"firewall.cfg9002.proto='all'",
	"firewall.cfg9002.target='REJECT'"
].join('\n'), 'firewall');

ok('uciIpv6BlockStatus 全对时 ok', core.uciIpv6BlockStatus(v6Good).ok === true, JSON.stringify(core.uciIpv6BlockStatus(v6Good).problems));
ok('ipv6ProblemText 出中文说明', /IPv6/.test(core.ipv6ProblemText([ 'no-rule' ])));

/* DNS 上游判定：内网地址会绕过 TUN → 国外域名被投毒 */
ok('isPrivateIp 192.168.18.1 是内网', core.isPrivateIp('192.168.18.1') === true);
ok('isPrivateIp 10.x 是内网', core.isPrivateIp('10.0.0.1') === true);
ok('isPrivateIp 172.16-31 是内网', core.isPrivateIp('172.20.0.1') === true);
ok('isPrivateIp 169.254 是内网', core.isPrivateIp('169.254.1.1') === true);
ok('isPrivateIp 223.5.5.5 是公网', core.isPrivateIp('223.5.5.5') === false);
ok('isPrivateIp 119.29.29.29 是公网', core.isPrivateIp('119.29.29.29') === false);
ok('isPrivateIp 域名保守当作会绕过', core.isPrivateIp('dns.example.com') === true);

/* ---------- DNS 地址 / 协议解析 ---------- */
ok('DNS_PROTOCOLS 含 DoT', core.DNS_PROTOCOLS.some(p => p.value === 'tls'));
ok('DNS_PROTOCOLS 含 DoH/DoQ/DoH3', [ 'https', 'quic', 'h3' ].every(v => core.DNS_PROTOCOLS.some(p => p.value === v)));
ok('DNS_PROTOCOLS 不含 dhcp（本 build 未编译）', !core.DNS_PROTOCOLS.some(p => p.value === 'dhcp'));
ok('dnsProtocolInfo(DoT) 默认端口 853', core.dnsProtocolInfo('tls').defaultPort === 853);
ok('dnsProtocolInfo(DoH) 默认端口 443', core.dnsProtocolInfo('https').defaultPort === 443);
ok('dnsProtocolInfo(UDP) 默认端口 53', core.dnsProtocolInfo('udp').defaultPort === 53);
ok('dnsProtocolLabel 返回可读名', /DoT/.test(core.dnsProtocolLabel('tls')));

let ep = core.parseDnsEndpoint('223.5.5.5');
ok('parseDnsEndpoint 裸 IPv4', ep.server === '223.5.5.5' && ep.port === null);
ep = core.parseDnsEndpoint('1.1.1.1:853');
ok('parseDnsEndpoint IPv4:端口', ep.server === '1.1.1.1' && ep.port === 853);
ep = core.parseDnsEndpoint('dns.google');
ok('parseDnsEndpoint 域名', ep.server === 'dns.google' && ep.port === null);
ep = core.parseDnsEndpoint('dns.google:853');
ok('parseDnsEndpoint 域名:端口', ep.server === 'dns.google' && ep.port === 853);
ep = core.parseDnsEndpoint('[2606:4700:4700::1111]:853');
ok('parseDnsEndpoint [IPv6]:端口', ep.server === '2606:4700:4700::1111' && ep.port === 853);
ep = core.parseDnsEndpoint('2606:4700:4700::1111');
ok('parseDnsEndpoint 裸 IPv6 不当成 host:port', ep.server === '2606:4700:4700::1111' && ep.port === null);
ep = core.parseDnsEndpoint('  ');
ok('parseDnsEndpoint 空串报错', ep.error === 'empty');
ep = core.parseDnsEndpoint('1.1.1.1:99999');
ok('parseDnsEndpoint 端口越界报错', ep.error === 'bad-port');
ep = core.parseDnsEndpoint('https://1.1.1.1/dns-query');
ok('parseDnsEndpoint 拒绝 URL', !!ep.error);
ep = core.parseDnsEndpoint('localhost');
ok('parseDnsEndpoint 拒绝无点单标签', ep.error === 'bad-server');

let entry = core.applyDnsEndpoint({ tag: 'dns_cn', type: 'udp', server: 'x' }, 'tls', { server: '223.5.5.5', port: 853 });
ok('applyDnsEndpoint 写入 type/server_port', entry.type === 'tls' && entry.server === '223.5.5.5' && entry.server_port === 853);
entry = core.applyDnsEndpoint({ tag: 'dns_cn', type: 'tls', server: 'x', server_port: 853 }, 'udp', { server: '223.5.5.5', port: null });
ok('applyDnsEndpoint 端口为空时删掉 server_port', !('server_port' in entry) && entry.type === 'udp');

/* ---------- rule-set 内容校验 ---------- */
ok('validateRuleSetJson 接受正常结构',
	core.validateRuleSetJson('{"version":1,"rules":[{"ip_cidr":["1.0.1.0/24"]}]}').rules === 1);
ok('validateRuleSetJson 拒绝空 rules',
	core.validateRuleSetJson('{"version":1,"rules":[]}').error === 'no-rules');
ok('validateRuleSetJson 拒绝坏 JSON',
	core.validateRuleSetJson('<html>404</html>').error === 'bad-json');
ok('validateRuleSetJson 拒绝缺 rules',
	core.validateRuleSetJson('{"version":1}').error === 'no-rules');
ok('ruleSetMatchHit 命中', core.ruleSetMatchHit('match rules.[0]: ip_cidr=<binary>') === true);
ok('ruleSetMatchHit 未命中（空输出）', core.ruleSetMatchHit('') === false);
ok('ruleSetMatchHit 不把 mismatch 当命中', core.ruleSetMatchHit('mismatch something') === false);

/* ---------- 6. 产出样例配置给 sing-box check 用 ---------- */

const samplePath = process.env.SINGBOX_SAMPLE || path.join(require('os').tmpdir(), 'luci-singbox-sample.json');
const outCfg = core.parseJsonc(realCfgText);

/* 出厂模板里有 YOUR_* 占位符，sing-box check 会因 public_key 非法而失败；
   这一步只针对测试产物做替换，不涉及固件里的真实配置 */
const SUBST = {
	YOUR_SERVER: 'example.com',
	YOUR_UUID: '11111111-2222-3333-4444-555555555555',
	YOUR_REALITY_PUBLIC_KEY: 'AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04',
	YOUR_REALITY_SHORT_ID: 'ab12',
	YOUR_SNI: 'www.bing.com',
	YOUR_PASSWORD: 'pass456'
};
(function walk(v) {
	if (Array.isArray(v)) return v.forEach(walk);
	if (v && typeof v === 'object') {
		for (const k in v) {
			if (typeof v[k] === 'string' && SUBST[v[k]]) v[k] = SUBST[v[k]];
			else walk(v[k]);
		}
	}
})(outCfg);

core.mergeNodes(outCfg, rPlain.nodes, { syncMembers: true });
fs.writeFileSync(samplePath, JSON.stringify(outCfg, null, 2) + '\n', 'utf8');

/* ---------- 结果 ---------- */

console.log('');
console.log('passed: ' + pass + ', failed: ' + fail);
console.log('sample config written to: ' + samplePath);

if (fail) {
	console.log('\nFAILURES:');
	failures.forEach(f => console.log('  - ' + f));
	process.exit(1);
}
