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

/* 按 LuCI 的方式加载模块：把源码包成 function(require, exports, module) 并取 return 值 */
function loadCore() {
	const src = fs.readFileSync(path.join(ROOT, 'htdocs/luci-static/resources/singbox/core.js'), 'utf8');
	const factory = new Function('require', 'exports', 'module', src);
	const mod = { exports: {} };
	const ret = factory(function() { throw new Error('core.js 不应 require 任何模块'); }, mod.exports, mod);
	return ret || mod.exports;
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

/* tag 去重 */
const dup = [
	{ type: 'vless', tag: '同名' }, { type: 'vless', tag: '同名' }, { type: 'vless', tag: '' }
];
core.assignTags(dup);
eq('tag 去重', dup.map(n => n.tag), [ '同名', '同名-2', 'node-3' ]);

/* ---------- 5. 产出样例配置给 sing-box check 用 ---------- */

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
