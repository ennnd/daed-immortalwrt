'use strict';
'require baseclass';
/*
 * luci-app-singbox 纯逻辑层
 *
 * 这里只有字符串/JSON 处理，不依赖 LuCI 的 require、也不碰 DOM，
 * 因此可以直接用 node 跑 test/run.js 做单测（CI 里也是这么跑的）。
 *
 * 为什么不用 ucode 写后端：见 NEWIFI3-SINGBOX.md「LuCI 面板」一节。
 */

var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

var B64MAP = null;
function b64map() {
	if (B64MAP)
		return B64MAP;

	B64MAP = {};

	for (var i = 0; i < B64CHARS.length; i++)
		B64MAP[B64CHARS.charAt(i)] = i;

	/* URL-safe 变体 */
	B64MAP['-'] = 62;
	B64MAP['_'] = 63;

	return B64MAP;
}

function trimStr(s) {
	if (s == null)
		return '';

	s = String(s);

	var a = 0, b = s.length;

	while (a < b && /\s/.test(s.charAt(a)))
		a++;

	while (b > a && /\s/.test(s.charAt(b - 1)))
		b--;

	return s.substring(a, b);
}

/* ---------------- base64 ---------------- */

function b64ToBytes(input) {
	var map = b64map();
	var s = String(input == null ? '' : input).replace(/[\s]/g, '');
	var bytes = [];
	var buf = 0, bits = 0;
	var i, c, v;

	for (i = 0; i < s.length; i++) {
		c = s.charAt(i);

		if (c === '=')
			break;

		v = map[c];

		if (v === undefined)
			continue;	/* 容错：忽略非法字符 */

		buf = (buf << 6) | v;
		bits += 6;

		if (bits >= 8) {
			bits -= 8;
			bytes.push((buf >> bits) & 0xff);
		}
	}

	return bytes;
}

function utf8Decode(bytes) {
	var out = '';
	var i = 0, n = bytes.length;
	var b, cp, extra, j;

	while (i < n) {
		b = bytes[i++];

		if (b < 0x80) {
			out += String.fromCharCode(b);
			continue;
		}

		if ((b & 0xe0) === 0xc0) {
			cp = b & 0x1f;
			extra = 1;
		}
		else if ((b & 0xf0) === 0xe0) {
			cp = b & 0x0f;
			extra = 2;
		}
		else if ((b & 0xf8) === 0xf0) {
			cp = b & 0x07;
			extra = 3;
		}
		else {
			out += '\ufffd';
			continue;
		}

		for (j = 0; j < extra; j++) {
			if (i >= n) {
				cp = -1;
				break;
			}

			b = bytes[i++];

			if ((b & 0xc0) !== 0x80) {
				cp = -1;
				break;
			}

			cp = (cp << 6) | (b & 0x3f);
		}

		if (cp < 0) {
			out += '\ufffd';
			continue;
		}

		if (cp > 0xffff) {
			cp -= 0x10000;
			out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
		}
		else {
			out += String.fromCharCode(cp);
		}
	}

	return out;
}

function b64DecodeString(input) {
	try {
		return utf8Decode(b64ToBytes(input));
	}
	catch (e) {
		return '';
	}
}

function looksBase64(s) {
	if (typeof s !== 'string')
		return false;

	var t = s.replace(/\s+/g, '');

	if (t.length < 16)
		return false;

	return /^[A-Za-z0-9+/=_-]+$/.test(t);
}

/* ---------------- JSONC ---------------- */

/* 把 // 与 / * * / 注释剥掉（字符串感知，不会误伤 "https://..."） */
function stripComments(src) {
	var out = [];
	var i = 0, n = src.length;
	var c, state = 0;	/* 0=普通 1=字符串 2=行注释 3=块注释 */

	while (i < n) {
		c = src.charAt(i);

		if (state === 0) {
			if (c === '"') {
				state = 1;
				out.push(c);
				i++;
				continue;
			}

			if (c === '/' && src.charAt(i + 1) === '/') {
				state = 2;
				i += 2;
				continue;
			}

			if (c === '/' && src.charAt(i + 1) === '*') {
				state = 3;
				i += 2;
				continue;
			}

			out.push(c);
			i++;
			continue;
		}

		if (state === 1) {
			if (c === '\\') {
				out.push(c, src.charAt(i + 1));
				i += 2;
				continue;
			}

			if (c === '"')
				state = 0;

			out.push(c);
			i++;
			continue;
		}

		if (state === 2) {
			if (c === '\n') {
				state = 0;
				out.push(c);
			}

			i++;
			continue;
		}

		/* state === 3 */
		if (c === '*' && src.charAt(i + 1) === '/') {
			state = 0;
			i += 2;
			continue;
		}

		i++;
	}

	return out.join('');
}

/* 去掉尾逗号（同样字符串感知） */
function stripTrailingCommas(s) {
	var out = [];
	var i = 0, n = s.length;
	var c, k, state = 0;

	while (i < n) {
		c = s.charAt(i);

		if (state === 1) {
			if (c === '\\') {
				out.push(c, s.charAt(i + 1));
				i += 2;
				continue;
			}

			if (c === '"')
				state = 0;

			out.push(c);
			i++;
			continue;
		}

		if (c === '"') {
			state = 1;
			out.push(c);
			i++;
			continue;
		}

		if (c === ',') {
			k = i + 1;

			while (k < n && /\s/.test(s.charAt(k)))
				k++;

			if (s.charAt(k) === '}' || s.charAt(k) === ']') {
				i++;
				continue;
			}
		}

		out.push(c);
		i++;
	}

	return out.join('');
}

function stripJsonc(src) {
	return stripTrailingCommas(stripComments(String(src == null ? '' : src)));
}

function parseJsonc(src) {
	return JSON.parse(stripJsonc(src));
}

/* ---------------- URI 辅助 ---------------- */

function urldecode(s) {
	if (s == null)
		return '';

	try {
		return decodeURIComponent(String(s));
	}
	catch (e) {
		return String(s);
	}
}

function parseQuery(str) {
	var out = {};

	if (str == null || str === '')
		return out;

	var parts = String(str).split('&');

	for (var i = 0; i < parts.length; i++) {
		if (parts[i] === '')
			continue;

		var eq = parts[i].indexOf('=');
		var k = (eq < 0) ? parts[i] : parts[i].substring(0, eq);
		var v = (eq < 0) ? '' : parts[i].substring(eq + 1);

		out[urldecode(k)] = urldecode(v);
	}

	return out;
}

function isTrue(v) {
	if (v === true || v === 1)
		return true;

	var s = String(v == null ? '' : v).toLowerCase();

	return (s === '1' || s === 'true' || s === 'yes');
}

/*
 * 拆 <userinfo>@<host>:<port>?<query>#<tag>
 * 返回 { userinfo, host, port, query, tag }
 */
function splitUri(body) {
	var rest = String(body == null ? '' : body);
	var tag = null, query = '';

	var hash = rest.indexOf('#');

	if (hash >= 0) {
		tag = urldecode(rest.substring(hash + 1));
		rest = rest.substring(0, hash);
	}

	var q = rest.indexOf('?');

	if (q >= 0) {
		query = rest.substring(q + 1);
		rest = rest.substring(0, q);
	}

	while (rest.length && rest.charAt(rest.length - 1) === '/')
		rest = rest.substring(0, rest.length - 1);

	var userinfo = '', hostport = rest;
	var at = rest.lastIndexOf('@');

	if (at >= 0) {
		userinfo = rest.substring(0, at);
		hostport = rest.substring(at + 1);
	}

	var host = hostport, port = 0;

	if (hostport.charAt(0) === '[') {
		var e = hostport.indexOf(']');

		host = hostport.substring(1, e);

		if (hostport.charAt(e + 1) === ':')
			port = parseInt(hostport.substring(e + 2), 10);
	}
	else {
		var c = hostport.lastIndexOf(':');

		if (c >= 0) {
			host = hostport.substring(0, c);
			port = parseInt(hostport.substring(c + 1), 10);
		}
	}

	return {
		userinfo: userinfo,
		host: host,
		port: port || 0,
		query: parseQuery(query),
		tag: tag
	};
}

/* 传输层映射；返回 null 表示默认(tcp)，'grpc'/'unsupported' 表示当前固件不支持 */
function buildTransport(kind, q) {
	var t = trimStr(kind).toLowerCase();
	var path = q.path || '';
	var host = q.host || '';

	if (t === '' || t === 'tcp' || t === 'none')
		return null;

	if (t === 'grpc')
		return 'grpc';

	if (t === 'ws') {
		var ws = { type: 'ws', path: path || '/' };

		if (host)
			ws.headers = { Host: host };

		return ws;
	}

	if (t === 'httpupgrade') {
		var hu = { type: 'httpupgrade', path: path || '/' };

		if (host)
			hu.host = host;

		return hu;
	}

	if (t === 'http' || t === 'h2') {
		var h2 = { type: 'http', path: path || '/' };

		if (host)
			h2.host = [ host ];

		return h2;
	}

	return 'unsupported';	/* kcp / quic / xhttp ... */
}

/* 返回 tls 对象、null（不需要）或 'reality-key'（缺公钥） */
function buildTls(opt) {
	var sec = trimStr(opt.security).toLowerCase();

	if (sec === '' || sec === 'none')
		return null;

	if (sec === 'reality') {
		if (!opt.pbk)
			return 'reality-key';

		/* 机场里常见 pbk 被截断/带了多余字符，交给 sing-box 只会得到
		   initialize outbound[N]: invalid public_key，这里提前判掉 */
		if (!realityKeyOk(opt.pbk))
			return 'bad-reality-key';

		if (opt.sid && !shortIdOk(opt.sid))
			return 'bad-short-id';

		var rtls = {
			enabled: true,
			utls: {
				enabled: true,
				fingerprint: opt.fp || 'chrome'
			},
			reality: {
				enabled: true,
				public_key: opt.pbk,
				short_id: opt.sid || ''
			}
		};

		if (opt.sni)
			rtls.server_name = opt.sni;

		if (opt.alpn && opt.alpn.length)
			rtls.alpn = opt.alpn;

		return rtls;
	}

	var tls = { enabled: true };

	if (opt.sni)
		tls.server_name = opt.sni;

	if (opt.alpn && opt.alpn.length)
		tls.alpn = opt.alpn;

	if (opt.insecure)
		tls.insecure = true;

	if (opt.fp) {
		tls.utls = {
			enabled: true,
			fingerprint: opt.fp
		};
	}

	return tls;
}

/* ---------------- 各协议解析 ---------------- */

function parseVless(body) {
	var u = splitUri(body);

	if (!u.userinfo || !u.host || !u.port)
		return { skip: 'no-auth' };

	var q = u.query;
	var tr = buildTransport(q.type, q);

	if (tr === 'grpc')
		return { skip: 'grpc' };

	if (tr === 'unsupported')
		return { skip: 'transport' };

	var tls = buildTls({
		security: q.security || 'none',
		sni: q.sni || '',
		fp: q.fp,
		pbk: q.pbk,
		sid: q.sid,
		alpn: q.alpn ? String(q.alpn).split(',') : null,
		insecure: isTrue(q.allowInsecure) || isTrue(q.insecure)
	});

	if (typeof tls === 'string')
		return { skip: tls };

	var node = {
		type: 'vless',
		tag: u.tag || '',
		server: u.host,
		server_port: u.port,
		uuid: u.userinfo
	};

	if (q.flow)
		node.flow = q.flow;

	if (q.encryption && q.encryption !== 'none')
		node.encryption = q.encryption;

	if (tr)
		node.transport = tr;

	if (tls)
		node.tls = tls;

	return { node: node };
}

function parseTrojan(body) {
	var u = splitUri(body);

	if (!u.userinfo || !u.host || !u.port)
		return { skip: 'no-auth' };

	var q = u.query;
	var tr = buildTransport(q.type, q);

	if (tr === 'grpc')
		return { skip: 'grpc' };

	if (tr === 'unsupported')
		return { skip: 'transport' };

	var node = {
		type: 'trojan',
		tag: u.tag || '',
		server: u.host,
		server_port: u.port,
		password: u.userinfo,
		tls: buildTls({
			security: 'tls',
			sni: q.sni || q.peer || '',
			fp: q.fp,
			alpn: q.alpn ? String(q.alpn).split(',') : null,
			insecure: isTrue(q.allowInsecure) || isTrue(q.insecure)
		})
	};

	if (tr)
		node.transport = tr;

	return { node: node };
}

function parseShadowsocks(body) {
	var raw = String(body == null ? '' : body);
	var tag = '';
	var hash = raw.indexOf('#');

	if (hash >= 0) {
		tag = urldecode(raw.substring(hash + 1));
		raw = raw.substring(0, hash);
	}

	var qmark = raw.indexOf('?');
	var query = qmark >= 0 ? parseQuery(raw.substring(qmark + 1)) : {};

	if (qmark >= 0)
		raw = raw.substring(0, qmark);

	if (query.plugin)
		return { skip: 'plugin' };

	if (raw.indexOf('@') < 0) {
		/* 老格式：ss://base64(method:password@host:port) */
		var dec = b64DecodeString(raw);
		var at = dec.lastIndexOf('@');

		if (at < 0)
			return { skip: 'bad-uri' };

		raw = dec.substring(0, at) + '@' + dec.substring(at + 1);
	}

	var u = splitUri(raw);

	if (!u.host || !u.port)
		return { skip: 'bad-uri' };

	var userinfo = u.userinfo;
	var method = '', password = '';

	if (userinfo.indexOf(':') < 0) {
		var plain = b64DecodeString(userinfo);

		if (plain.indexOf(':') < 0)
			return { skip: 'bad-uri' };

		method = plain.substring(0, plain.indexOf(':'));
		password = plain.substring(plain.indexOf(':') + 1);
	}
	else {
		method = userinfo.substring(0, userinfo.indexOf(':'));
		password = userinfo.substring(userinfo.indexOf(':') + 1);
	}

	if (!method || !password)
		return { skip: 'no-auth' };

	return {
		node: {
			type: 'shadowsocks',
			tag: tag,
			server: u.host,
			server_port: u.port,
			method: method,
			password: password
		}
	};
}

function parseHysteria2(body) {
	var u = splitUri(body);

	if (!u.host || !u.port)
		return { skip: 'bad-uri' };

	var q = u.query;
	var password = u.userinfo;

	if (!password)
		password = q.auth || '';

	if (!password)
		return { skip: 'no-auth' };

	var node = {
		type: 'hysteria2',
		tag: u.tag || '',
		server: u.host,
		server_port: u.port,
		password: password,
		tls: buildTls({
			security: 'tls',
			sni: q.sni || '',
			alpn: q.alpn ? String(q.alpn).split(',') : null,
			insecure: isTrue(q.insecure) || isTrue(q.allowInsecure)
		})
	};

	if (q.obfs && q.obfs !== 'none') {
		node.obfs = {
			type: q.obfs,
			password: q['obfs-password'] || q.obfs_password || ''
		};
	}

	return { node: node };
}

function parseTuic(body) {
	var u = splitUri(body);

	if (!u.userinfo || !u.host || !u.port)
		return { skip: 'no-auth' };

	var q = u.query;
	var sep = u.userinfo.indexOf(':');

	if (sep < 0)
		return { skip: 'no-auth' };

	var node = {
		type: 'tuic',
		tag: u.tag || '',
		server: u.host,
		server_port: u.port,
		uuid: u.userinfo.substring(0, sep),
		password: u.userinfo.substring(sep + 1),
		tls: buildTls({
			security: 'tls',
			sni: q.sni || '',
			alpn: q.alpn ? String(q.alpn).split(',') : [ 'h3' ],
			insecure: isTrue(q.allow_insecure) || isTrue(q.insecure)
		})
	};

	node.congestion_control = q.congestion_control || 'bbr';

	if (q.udp_relay_mode)
		node.udp_relay_mode = q.udp_relay_mode;

	return { node: node };
}

function parseVmess(body) {
	var raw = String(body == null ? '' : body);
	var tag = '';
	var hash = raw.indexOf('#');

	if (hash >= 0) {
		tag = urldecode(raw.substring(hash + 1));
		raw = raw.substring(0, hash);
	}

	var qmark = raw.indexOf('?');

	if (qmark >= 0)
		raw = raw.substring(0, qmark);

	raw = raw.replace(/\/+$/, '');

	var o = null;

	try {
		o = JSON.parse(b64DecodeString(raw));
	}
	catch (e) {
		return { skip: 'bad-uri' };
	}

	if (!o || typeof o !== 'object' || !o.add || !o.id)
		return { skip: 'no-auth' };

	var port = parseInt(o.port, 10);

	if (!port)
		return { skip: 'bad-uri' };

	var net = trimStr(o.net || 'tcp').toLowerCase();
	var typ = trimStr(o.type || 'none').toLowerCase();

	if (net === 'grpc' || typ === 'gun')
		return { skip: 'grpc' };

	if (net === 'kcp' || net === 'quic' || net === 'xhttp')
		return { skip: 'transport' };

	var node = {
		type: 'vmess',
		tag: tag || o.ps || '',
		server: o.add,
		server_port: port,
		uuid: o.id,
		security: trimStr(o.scy || 'auto') || 'auto',
		alter_id: parseInt(o.aid || 0, 10) || 0
	};

	if (net === 'ws') {
		node.transport = { type: 'ws', path: o.path || '/' };

		if (o.host)
			node.transport.headers = { Host: o.host };
	}
	else if (net === 'h2' || net === 'http') {
		node.transport = { type: 'http', path: o.path || '/' };

		if (o.host)
			node.transport.host = [ o.host ];
	}
	else if (net === 'tcp' && typ === 'http') {
		node.transport = { type: 'http', path: o.path || '/' };

		if (o.host)
			node.transport.host = [ o.host ];
	}

	if (o.tls === 'tls' || o.tls === true) {
		node.tls = buildTls({
			security: 'tls',
			sni: o.sni || o.host || '',
			fp: o.fp,
			alpn: o.alpn ? String(o.alpn).split(',') : null,
			insecure: isTrue(o.allowInsecure) || isTrue(o['skip-cert-verify'])
		});
	}

	return { node: node };
}

function parseUri(line) {
	var s = trimStr(line);
	var m = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\/([\s\S]*)$/.exec(s);

	if (!m)
		return { skip: 'bad-uri' };

	var scheme = m[1].toLowerCase();
	var body = m[2];

	switch (scheme) {
	case 'vmess':
		return parseVmess(body);
	case 'vless':
		return parseVless(body);
	case 'trojan':
		return parseTrojan(body);
	case 'ss':
		return parseShadowsocks(body);
	case 'hysteria2':
	case 'hy2':
		return parseHysteria2(body);
	case 'tuic':
		return parseTuic(body);
	case 'ssr':
		return { skip: 'ssr' };
	case 'wireguard':
		return { skip: 'wireguard' };
	case 'naive':
	case 'naive+https':
	case 'naive+quic':
		return { skip: 'naive' };
	case 'openvpn':
		return { skip: 'openvpn' };
	default:
		return { skip: 'scheme' };
	}
}

/* ---------------- tag 处理 ---------------- */

function sanitizeTag(t, fallback) {
	var s = trimStr(t).replace(/[\r\n\t]+/g, ' ');

	/* tag 会写进 JSON 与日志，去掉控制字符即可，中文保留 */
	s = s.replace(/[\u0000-\u001f]/g, '');

	if (s === '')
		s = trimStr(fallback) || 'node';

	return s;
}

/* 给节点补 tag 并去重（-2/-3 ...） */
function assignTags(nodes, prefix) {
	var used = {};
	var i, t;

	for (i = 0; i < nodes.length; i++) {
		t = sanitizeTag(nodes[i].tag, (prefix || 'node-') + (i + 1));

		var base = t, n = 2;

		while (used[t]) {
			t = base + '-' + n;
			n++;
		}

		used[t] = true;
		nodes[i].tag = t;
	}

	return nodes;
}

/* ---------------- 订阅 ---------------- */

var CONTAINER_TYPES = { direct: 1, block: 1, selector: 1, urltest: 1, 'dns': 1 };

function isProxyOutbound(o) {
	if (!o || typeof o !== 'object' || !o.type)
		return false;

	return !CONTAINER_TYPES[String(o.type).toLowerCase()];
}

/* 容忍注释的 JSON.parse（订阅里偶尔也会是带注释的 sing-box 配置） */
function parseSubscriptionJson(text) {
	var o = null;

	try {
		o = parseJsonc(text);
	}
	catch (e) {
		return null;
	}

	if (!o)
		return null;

	var list = null;

	if (Array.isArray(o))
		list = o;
	else if (Array.isArray(o.outbounds))
		list = o.outbounds;

	if (!list)
		return null;

	var nodes = [];

	for (var i = 0; i < list.length; i++) {
		if (isProxyOutbound(list[i]))
			nodes.push(JSON.parse(JSON.stringify(list[i])));
	}

	return nodes;
}

/*
 * 解析订阅内容，返回 { format, nodes, skipped }
 * format: json / base64 / plain / empty
 * skipped: [{ reason, sample }]
 */
function parseSubscription(text, depth) {
	depth = depth || 0;

	var t = trimStr(text);

	if (t === '')
		return { format: 'empty', nodes: [], skipped: [] };

	/* ① 直接是 sing-box JSON */
	if (t.charAt(0) === '{' || t.charAt(0) === '[') {
		var jn = parseSubscriptionJson(t);

		if (jn) {
			assignTags(jn);
			return { format: 'json', nodes: jn, skipped: [] };
		}
	}

	/* ② 明文 URI 列表 */
	var lines = t.split(/\r?\n/);
	var uriLines = [];
	var i;

	for (i = 0; i < lines.length; i++) {
		var l = trimStr(lines[i]);

		if (l !== '')
			uriLines.push(l);
	}

	var onlyUri = true;

	for (i = 0; i < uriLines.length; i++) {
		if (!/^[A-Za-z][A-Za-z0-9+.\-]*:\/\//.test(uriLines[i])) {
			onlyUri = false;
			break;
		}
	}

	if (uriLines.length && onlyUri) {
		var nodes = [], skipped = [];

		for (i = 0; i < uriLines.length; i++) {
			var res = parseUri(uriLines[i]);

			if (res.node)
				nodes.push(res.node);
			else
				skipped.push({ reason: res.skip, sample: uriLines[i].substring(0, 60) });
		}

		assignTags(nodes);

		return {
			format: 'plain',
			nodes: nodes,
			skipped: skipped
		};
	}

	/* ③ base64 包装 */
	if (depth < 2 && looksBase64(t)) {
		var dec = b64DecodeString(t);

		if (dec && dec !== t) {
			var r = parseSubscription(dec, depth + 1);

			if (r.nodes.length || r.skipped.length) {
				r.format = 'base64';
				return r;
			}
		}
	}

	return { format: 'empty', nodes: [], skipped: [] };
}

var SKIP_REASONS = {
	'grpc': 'gRPC 传输（本固件未编译 with_grpc）',
	'plugin': 'Shadowsocks 插件型',
	'transport': '不支持的传输方式（kcp/quic/xhttp 等）',
	'ssr': 'ShadowsocksR',
	'wireguard': 'WireGuard',
	'naive': 'NaiveProxy',
	'openvpn': 'OpenVPN',
	'scheme': '不认识的协议',
	'no-auth': '缺少凭据',
	'reality-key': 'Reality 缺 public_key',
	'bad-reality-key': 'Reality 公钥不是 43 位 base64url（多半是复制时被截断）',
	'bad-short-id': 'Reality short_id 不是十六进制',
	'bad-uri': '链接格式错误'
};

function skipReasonText(reason) {
	return SKIP_REASONS[reason] || reason || '未知原因';
}

/* 把 skipped 汇总成 [{ reason, text, count, samples }]，按数量降序 */
function summarizeSkipped(skipped) {
	var map = {}, out = [];

	for (var i = 0; i < skipped.length; i++) {
		var r = skipped[i].reason;

		if (!map[r])
			map[r] = { reason: r, text: skipReasonText(r), count: 0, samples: [] };

		map[r].count++;

		if (map[r].samples.length < 3)
			map[r].samples.push(skipped[i].sample);
	}

	for (var k in map)
		out.push(map[k]);

	out.sort(function(a, b) { return b.count - a.count; });

	return out;
}

/* ---------------- 合并进配置 ---------------- */

function outboundTags(cfg) {
	var out = {}, list = (cfg && cfg.outbounds) || [];

	for (var i = 0; i < list.length; i++) {
		if (list[i] && list[i].tag)
			out[list[i].tag] = list[i];
	}

	return out;
}

/*
 * 修正 selector / urltest 的 members 与 default：
 * - members 里指向不存在 tag 的，删掉
 * - default 不在 members 里，改成第一个
 */
function normalizeMembers(cfg) {
	var fixes = [];
	var list = (cfg && cfg.outbounds) || [];
	var tags = outboundTags(cfg);
	var i, j;

	for (i = 0; i < list.length; i++) {
		var ob = list[i];

		if (!ob || (ob.type !== 'selector' && ob.type !== 'urltest'))
			continue;

		if (!Array.isArray(ob.outbounds))
			ob.outbounds = [];

		var kept = [];

		for (j = 0; j < ob.outbounds.length; j++) {
			var t = ob.outbounds[j];

			if (t === ob.tag)
				continue;

			if (!tags[t]) {
				fixes.push(ob.tag + ': 移除不存在的成员 ' + t);
				continue;
			}

			kept.push(t);
		}

		/* 所有代理节点都没进 members 时，补进去（仅当原来是空） */
		if (!kept.length) {
			for (var k in tags) {
				if (isProxyOutbound(tags[k]) && k !== ob.tag)
					kept.push(k);
			}

			if (kept.length)
				fixes.push(ob.tag + ': 成员为空，自动补入 ' + kept.length + ' 个节点');
		}

		/*
		 * 一个节点都没有（例如刚把演示节点全删掉）时，组里留 direct，
		 * 否则 sing-box 报 initialize outbound[N]: missing tags，配置连 check 都过不了。
		 */
		if (!kept.length && tags['direct'] && ob.tag !== 'direct') {
			kept.push('direct');
			fixes.push(ob.tag + ': 没有可用节点，暂时指向 direct');
		}

		ob.outbounds = kept;

		if (ob.type === 'selector') {
			if (!ob.default || kept.indexOf(ob.default) < 0 || ob.default === ob.tag) {
				var nd = kept[0] || '';

				if (ob.default !== nd) {
					fixes.push(ob.tag + ': default 修正为 ' + (nd || '(空)'));
					ob.default = nd;
				}
			}
		}
	}

	return fixes;
}

/*
 * 把 nodes 合并进 cfg.outbounds：同 tag 覆盖，否则追加。
 * opts.syncMembers=true 时，把新 tag 追加到 selector / urltest 的 members。
 */
function mergeNodes(cfg, nodes, opts) {
	opts = opts || {};

	if (!Array.isArray(cfg.outbounds))
		cfg.outbounds = [];

	var existing = outboundTags(cfg);
	var added = [], replaced = [];
	var i;

	for (i = 0; i < nodes.length; i++) {
		var n = nodes[i];

		if (!n || !n.tag)
			continue;

		if (existing[n.tag]) {
			var idx = cfg.outbounds.indexOf(existing[n.tag]);

			cfg.outbounds[idx] = n;
			existing[n.tag] = n;
			replaced.push(n.tag);
		}
		else {
			cfg.outbounds.push(n);
			existing[n.tag] = n;
			added.push(n.tag);
		}
	}

	if (opts.syncMembers && added.length) {
		for (i = 0; i < cfg.outbounds.length; i++) {
			var ob = cfg.outbounds[i];

			if (!ob || (ob.type !== 'selector' && ob.type !== 'urltest') || ob.tag === undefined)
				continue;

			if (!Array.isArray(ob.outbounds))
				ob.outbounds = [];

			for (var j = 0; j < added.length; j++) {
				if (ob.outbounds.indexOf(added[j]) < 0 && added[j] !== ob.tag)
					ob.outbounds.push(added[j]);
			}
		}
	}

	var fixes = normalizeMembers(cfg);

	return {
		cfg: cfg,
		added: added,
		replaced: replaced,
		fixes: fixes
	};
}

function removeOutbound(cfg, tag) {
	var removed = false;
	var i;

	if (!cfg || !Array.isArray(cfg.outbounds))
		return { removed: false, fixes: [] };

	for (i = cfg.outbounds.length - 1; i >= 0; i--) {
		if (cfg.outbounds[i] && cfg.outbounds[i].tag === tag) {
			if (cfg.outbounds[i].type === 'selector' || cfg.outbounds[i].type === 'urltest'
				|| cfg.outbounds[i].type === 'direct')
				return { removed: false, fixes: [ '内置出站不能删除' ] };

			cfg.outbounds.splice(i, 1);
			removed = true;
		}
	}

	var fixes = normalizeMembers(cfg);

	return { removed: removed, fixes: fixes };
}

/* 节点表格里显示的摘要 */
function outboundSummary(o) {
	if (!o)
		return '';

	if (o.type === 'selector' || o.type === 'urltest' || o.type === 'direct')
		return '';

	var parts = [];

	if (o.server)
		parts.push(o.server + (o.server_port ? ':' + o.server_port : ''));

	if (o.method)
		parts.push(o.method);

	if (o.type === 'vless' && o.flow)
		parts.push(o.flow);

	if (o.transport && o.transport.type)
		parts.push(o.transport.type);

	if (o.tls && o.tls.reality && o.tls.reality.enabled)
		parts.push('reality');
	else if (o.tls && o.tls.enabled)
		parts.push('tls');

	return parts.join(' · ');
}

function proxyNodes(cfg) {
	var out = [], list = (cfg && cfg.outbounds) || [];

	for (var i = 0; i < list.length; i++) {
		if (isProxyOutbound(list[i]))
			out.push(list[i]);
	}

	return out;
}

/* ---------------- 字段校验与错误诊断 ---------------- */

/*
 * Reality public_key 是 32 字节 X25519 公钥的 base64url（无 padding）编码，
 * 固定 43 个字符。写错时 sing-box 只回一句 "invalid public_key"，
 * 完全看不出是哪个节点的哪个字段，所以先在客户端挡一道。
 */
var REALITY_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
var SHORT_ID_RE = /^([0-9a-fA-F]{2}){0,8}$/;

function realityKeyOk(k) {
	return REALITY_KEY_RE.test(trimStr(k || ''));
}

function shortIdOk(s) {
	return SHORT_ID_RE.test(trimStr(s || ''));
}

/*
 * 把 sing-box 的原始报错翻成人话。
 * 输入：配置文本 + check 的 stderr；输出：
 *   { raw, kind, index, tag, type, hint }
 * kind 为 'outbound' / 'inbound' / 'dns' / 'rule-set' / ''。
 */
var CHECK_HINTS = [
	[ /invalid public_key/i,
	  'Reality 公钥不合法：应为 43 位 base64url 字符（A-Z a-z 0-9 - _），可用 sing-box generate reality-keypair 生成' ],
	[ /decode short_id/i,
	  'Reality short_id 必须是偶数位的十六进制字符串（最多 16 位，例如 ab12cd34）' ],
	[ /invalid uuid|parse uuid|invalid UUID/i,
	  'UUID 格式不对，应为 8-4-4-4-12 的十六进制' ],
	[ /duplicate outbound\/endpoint tag|duplicate .* tag/i,
	  'tag 重名：每个节点/出站的 tag 必须唯一' ],
	[ /no such file or directory/i,
	  '引用的文件不存在（常见于 rule-set 尚未下载）' ],
	[ /unknown field/i,
	  '配置里出现了当前版本不认识的字段（可能是旧版写法，或 tiny 构建没编这个特性）' ],
	[ /unknown (transport|outbound|inbound) type|unsupported/i,
	  '当前固件不支持这个协议特性（tiny 构建裁剪了很多无关模块）' ],
	[ /invalid (port|server_port)/i, '端口不合法，应为 1~65535' ],
	[ /missing tags/i, '有一个 selector/urltest 出站成员为空，请先在「节点」页添加节点' ],
	[ /cannot unmarshal|json:/i, '配置不是合法 JSON，或字段类型不对（字符串/数字写反了）' ]
];

function explainCheckError(cfgText, errText) {
	var raw = trimStr(errText || '');
	var info = { raw: raw, kind: '', index: -1, tag: '', type: '', hint: '' };
	var cfg = null, m;

	try {
		cfg = parseJsonc(cfgText || '');
	}
	catch (e) {
		cfg = null;
	}

	if (raw && cfg) {
		m = /initialize\s+(outbound|inbound|dns|rule-set)\s*\[(\d+)\]/i.exec(raw);

		if (m) {
			var kind = m[1].toLowerCase();
			var idx = parseInt(m[2], 10);
			var list = null;

			if (kind === 'outbound')
				list = cfg.outbounds;
			else if (kind === 'inbound')
				list = cfg.inbounds;
			else if (kind === 'rule-set')
				list = cfg.route && cfg.route.rule_set;
			else if (kind === 'dns')
				list = cfg.dns && cfg.dns.servers;

			var item = list && list[idx];

			if (item) {
				info.kind = kind;
				info.index = idx;
				info.tag = item.tag || '';
				info.type = item.type || '';
			}
		}
	}

	for (var i = 0; i < CHECK_HINTS.length; i++) {
		if (CHECK_HINTS[i][0].test(raw)) {
			info.hint = CHECK_HINTS[i][1];
			break;
		}
	}

	return info;
}

/*
 * 找出所有还没填的出厂占位符（"YOUR_XXX"），返回
 *   [ { where: 'outbound', index: 2, tag: 'node1', fields: ['YOUR_SERVER', ...] } ]
 */
function scanPlaceholders(cfg) {
	var found = [];

	function scan(list, where) {
		(list || []).forEach(function(o, i) {
			var s;

			try {
				s = JSON.stringify(o);
			}
			catch (e) {
				return;
			}

			var names = s.match(/"YOUR_[A-Z0-9_]*"/g);

			if (!names)
				return;

			var fields = [];

			names.forEach(function(n) {
				var f = n.replace(/"/g, '');

				if (fields.indexOf(f) < 0)
					fields.push(f);
			});

			found.push({ where: where, index: i, tag: o.tag || '', fields: fields });
		});
	}

	if (!cfg)
		return found;

	scan(cfg.outbounds, 'outbound');
	scan(cfg.inbounds, 'inbound');
	scan(cfg.dns && cfg.dns.servers, 'dns');

	return found;
}

function placeholderText(found) {
	return (found || []).map(function(f) {
		return (f.tag || ('#' + (f.index + 1))) + '(' + f.fields.join('/') + ')';
	}).join('，');
}

/*
 * 必须 return 一个 class：LuCI 的 require() 会 new 它再返回实例，
 * 直接 return 普通对象会报 "factory yields invalid constructor"。
 */
return baseclass.extend({
	trimStr: trimStr,
	b64ToBytes: b64ToBytes,
	utf8Decode: utf8Decode,
	b64DecodeString: b64DecodeString,
	looksBase64: looksBase64,
	stripComments: stripComments,
	stripJsonc: stripJsonc,
	parseJsonc: parseJsonc,
	urldecode: urldecode,
	parseQuery: parseQuery,
	isTrue: isTrue,
	splitUri: splitUri,
	buildTransport: buildTransport,
	buildTls: buildTls,
	parseUri: parseUri,
	parseSubscription: parseSubscription,
	parseSubscriptionJson: parseSubscriptionJson,
	skipReasonText: skipReasonText,
	summarizeSkipped: summarizeSkipped,
	SKIP_REASONS: SKIP_REASONS,
	sanitizeTag: sanitizeTag,
	assignTags: assignTags,
	isProxyOutbound: isProxyOutbound,
	outboundTags: outboundTags,
	normalizeMembers: normalizeMembers,
	mergeNodes: mergeNodes,
	removeOutbound: removeOutbound,
	outboundSummary: outboundSummary,
	proxyNodes: proxyNodes,
	realityKeyOk: realityKeyOk,
	shortIdOk: shortIdOk,
	explainCheckError: explainCheckError,
	scanPlaceholders: scanPlaceholders,
	placeholderText: placeholderText
});
