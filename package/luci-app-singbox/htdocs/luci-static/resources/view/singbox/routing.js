'use strict';
'require view';
'require fs';
'require singbox.api as api';
'require singbox.core as core';
'require singbox.ui as sbui';

/* 分流模式：global 全局代理 / cn 大陆直连（默认）/ direct 全部直连 */
var SNIFF_RULE = {
	action: 'sniff',
	sniffer: [ 'dns', 'http', 'tls', 'quic' ],
	timeout: '300ms'
};

var HIJACK_RULE = { protocol: 'dns', action: 'hijack-dns' };
var PRIVATE_RULE = { ip_is_private: true, outbound: 'direct' };

var detectMode = function(cfg) {
	var route = (cfg && cfg.route) || {};
	var rules = route.rules || [];
	var final = route.final || 'proxy';

	if (final === 'direct')
		return 'direct';

	for (var i = 0; i < rules.length; i++) {
		if (rules[i].rule_set === 'geosite-cn' && rules[i].outbound === 'direct')
			return 'cn';
	}

	return 'global';
};

var buildRules = function(mode) {
	var clone = function(o) { return JSON.parse(JSON.stringify(o)); };
	var rules = [ clone(SNIFF_RULE), clone(HIJACK_RULE) ];

	if (mode !== 'direct')
		rules.push(clone(PRIVATE_RULE));

	if (mode === 'cn') {
		rules.push({ rule_set: 'geosite-cn', outbound: 'direct' });
		rules.push({ rule_set: 'geoip-cn', outbound: 'direct' });
	}

	return rules;
};

return view.extend({
	load: function() {
		return api.readConfig().then(function(r) {
			return { cfg: r.cfg, error: r.error, text: r.text };
		});
	},

	render: function(data) {
		this.bodyNode = E('div', {});

		this.redraw(data);

		return E('div', {}, [
			E('h2', {}, _('分流与 DNS')),
			this.bodyNode
		]);
	},

	reload: function() {
		var self = this;

		return api.readConfig().then(function(r) {
			self.redraw({ cfg: r.cfg, error: r.error, text: r.text });
		});
	},

	redraw: function(data) {
		while (this.bodyNode.firstChild)
			this.bodyNode.removeChild(this.bodyNode.firstChild);

		if (data.error) {
			this.bodyNode.appendChild(
				sbui.warn(_('config.json 解析失败：') + data.error + _('，请到「高级」页手工修正。')));

			return;
		}

		var self = this;
		var cfg = data.cfg;
		var mode = detectMode(cfg);
		var dns = cfg.dns || {};
		var modeCb = {};

		var modeRow = function(id, text, desc) {
			modeCb[id] = sbui.checkbox(mode === id, { 'type': 'radio', 'name': 'sb-mode', 'value': id });

			return E('div', { 'style': 'margin:.5em 0' }, [
				E('label', {}, [ modeCb[id], ' ', E('b', {}, text) ]),
				sbui.hint(desc)
			]);
		};

		var getServer = function(tag, fallback) {
			var list = dns.servers || [];

			for (var i = 0; i < list.length; i++) {
				if (list[i].tag === tag)
					return list[i];
			}

			return null;
		};

		/* 把 dns.servers 里的条目还原成"地址栏文本"：host 或 host:port */
		var endpointText = function(entry, fallback) {
			if (!entry || !entry.server)
				return fallback;

			var host = String(entry.server);
			var port = entry.server_port;
			var proto = core.dnsProtocolInfo(entry.type);

			/* IPv6 字面量要加方括号才能和端口区分 */
			if (host.indexOf(':') >= 0)
				host = '[' + host + ']';

			/* 端口等于该协议默认端口时不显示，保持界面干净 */
			if (port != null && port !== '' && (!proto || Number(port) !== proto.defaultPort))
				return host + ':' + port;

			return entry.server.indexOf(':') >= 0 ? host : entry.server;
		};

		var cnEntry = getServer('dns_cn');
		var proxyEntry = getServer('dns_proxy');

		var protoOpts = core.DNS_PROTOCOLS.map(function(p) {
			return { value: p.value, label: p.label };
		});
		var protoValues = core.DNS_PROTOCOLS.map(function(p) { return p.value; });

		var inCn = sbui.input(endpointText(cnEntry, '223.5.5.5'));
		var selCnProto = sbui.select(protoOpts, protoValues.indexOf((cnEntry || {}).type) >= 0
			? cnEntry.type : 'udp');

		var inProxy = sbui.input(endpointText(proxyEntry, '1.1.1.1'));
		var selProxyProto = sbui.select(protoOpts, protoValues.indexOf((proxyEntry || {}).type) >= 0
			? proxyEntry.type : 'https');

		var protoOf = function(sel, dflt) {
			var v = String((sel && sel.value) || '');

			return protoValues.indexOf(v) >= 0 ? v : dflt;
		};

		var selStrategy = sbui.select([ 'ipv4_only', 'prefer_ipv4', 'ipv6_only', 'prefer_ipv6' ],
			dns.strategy || 'ipv4_only');
		var inOptimistic = sbui.checkbox(dns.optimistic === true);
		var inTimeout = sbui.input(dns.timeout || '5s');

		var save = function(saveMode) {
			return api.readConfig().then(function(r) {
				if (r.error)
					throw new Error(_('当前 config.json 不是合法 JSON：') + r.error);

				var c = r.cfg;

				if (saveMode) {
					c.route = c.route || {};
					c.route.rules = buildRules(saveMode);
					c.route.final = (saveMode === 'direct') ? 'direct' : 'proxy';

					if (!c.route.default_domain_resolver)
						c.route.default_domain_resolver = { server: 'dns_cn' };
				}

				c.dns = c.dns || {};
				c.dns.servers = c.dns.servers || [];

				/* 统一走 core.applyDnsEndpoint，保证"界面保存"和"单测"是同一份逻辑 */
				var setServer = function(tag, type, endpoint) {
					var e = null;

					for (var i = 0; i < c.dns.servers.length; i++) {
						if (c.dns.servers[i].tag === tag) {
							e = c.dns.servers[i];
							break;
						}
					}

					if (!e) {
						e = {
							tag: tag,
							type: type,
							server: endpoint.server,
							detour: (tag === 'dns_cn') ? 'direct' : 'proxy'
						};
						c.dns.servers.push(e);
					}

					core.applyDnsEndpoint(e, type, endpoint);

					/* detour 由 tag 决定：国内直连、国外走代理 */
					e.detour = (tag === 'dns_cn') ? 'direct' : 'proxy';
				};

				var cnVal = core.trimStr(inCn.value);
				var proxyVal = core.trimStr(inProxy.value);

				if (!cnVal || !proxyVal)
					throw new Error(_('DNS 服务器地址不能为空'));

				var cnEp = core.parseDnsEndpoint(cnVal);
				var proxyEp = core.parseDnsEndpoint(proxyVal);

				if (cnEp.error)
					throw new Error(_('国内 DNS 地址无效（') + cnEp.error + _('）：') + cnVal);
				if (proxyEp.error)
					throw new Error(_('国外 DNS 地址无效（') + proxyEp.error + _('）：') + proxyVal);

				setServer('dns_cn', protoOf(selCnProto, 'udp'), cnEp);
				setServer('dns_proxy', protoOf(selProxyProto, 'https'), proxyEp);

				c.dns.strategy = selStrategy.value;

				if (inOptimistic.checked)
					c.dns.optimistic = true;
				else
					delete c.dns.optimistic;

				var t = core.trimStr(inTimeout.value);

				if (t)
					c.dns.timeout = t;

				return api.saveConfig(c, _('保存分流与 DNS'));
			}).then(function() {
				sbui.notifyOk(_('已保存并应用'));
				return self.reload();
			});
		};

		var ruleSets = ((cfg.route || {}).rule_set) || [];
		var sizeNodes = [];
		var statusNode = E('div', { 'style': 'margin-top:.6em;font-size:92%;line-height:1.6' }, '');

		var rsRows = ruleSets.map(function(rs) {
			var sizeNode = E('span', { 'style': 'opacity:.8' }, '…');

			if (rs.path)
				sizeNodes.push({ node: sizeNode, path: rs.path });

			var supported = api.ruleSetSupported(rs.tag);

			return [
				rs.tag || '—',
				E('span', { 'style': 'word-break:break-all;font-size:90%' }, rs.path || rs.url || '—'),
				sizeNode,
				supported
					? sbui.btn(_('更新'), '', sbui.action(function() {
						statusNode.textContent = _('正在下载并校验 ') + rs.tag + ' …';
						statusNode.style.color = '';

						return api.updateRuleSet(rs.tag).then(function(res) {
							statusNode.textContent = _('✅ ') + rs.tag + _(' 已更新：') +
								sbui.fmtBytes(res.size) + _('，') + res.rules + _(' 条规则') +
								_('（结构完整 + 国内探针命中 + 国外探针未命中，全部通过）');
							statusNode.style.color = '#080';
							sbui.notifyOk(rs.tag + _(' 已更新，') + sbui.fmtBytes(res.size));
							return self.reload();
						}).catch(function(e) {
							statusNode.textContent = _('❌ ') + rs.tag + _(' 更新失败：') +
								((e && e.message) || e) + _('　旧文件未被改动。');
							statusNode.style.color = '#c00';
							throw e;
						});
					}))
					: sbui.btn(_('不支持'), 'cbi-button-reset')
			];
		});

		this.bodyNode.appendChild(sbui.card(_('分流模式'), [
			modeRow('global', _('全局代理'), _('除内网外全部走 proxy；DNS 劫持保持开启。')),
			modeRow('cn', _('大陆直连（推荐）'), _('geosite-cn + geoip-cn 直连，其余走 proxy。')),
			modeRow('direct', _('全部直连'), _('只保留嗅探与 DNS 劫持，所有流量直连。')),
			E('div', { 'style': 'margin-top:.8em' }, [
				sbui.btn(_('应用分流模式'), 'cbi-button-apply', sbui.action(function() {
					var chosen = null;

					for (var k in modeCb) {
						if (modeCb[k].checked)
							chosen = k;
					}

					if (!chosen)
						throw new Error(_('请先选一个模式'));

					return save(chosen);
				}))
			]),
			sbui.hint(_('切换模式只改 route.rules 与 route.final，DNS、节点、rule-set 都不动。'))
		]));

		this.bodyNode.appendChild(sbui.card(_('规则集'), [
			sbui.table([ _('tag'), _('路径'), _('大小'), _('操作') ], rsRows,
				_('配置里没有 rule_set')),
			statusNode,
			sbui.hint(_('来源：SagerNet 的 rule-set 分支（多镜像回退：GitHub raw / jsDelivr / ghproxy）。') +
				_('注意：SagerNet 的 release 里现在只有 .db，sing-box 无法使用，这里取的是 .srs。')),
			sbui.hint(_('完整性校验（四道，全部通过才落盘）：① .srs 结构能完整解出（截断/错误页/空文件都会被识破）；') +
				_('② 解出的规则非空；③ 国内探针（223.5.5.5 / baidu.com）必须命中；④ 国外探针（8.8.8.8 / google.com）必须不命中。') +
				_('任一项不过即丢弃临时文件、保留旧文件。')),
			sbui.hint(_('不用「文件小于 100KB 就算失败」这种门槛：实测 geoip-cn.srs 仅约 33KB、geosite-cn.srs 约 55KB，') +
				_('按体积判断会把两个合法文件都误删。'))
		]));

		this.bodyNode.appendChild(sbui.card(_('DNS'), [
			sbui.kvTable([
				sbui.kvRow(_('国内 DNS 地址'), inCn),
				sbui.kvRow(_('国内 DNS 协议'), selCnProto),
				sbui.kvRow(_('国外 DNS 地址'), inProxy),
				sbui.kvRow(_('国外 DNS 协议'), selProxyProto),
				sbui.kvRow(_('strategy'), selStrategy),
				sbui.kvRow(_('乐观缓存 optimistic'), inOptimistic),
				sbui.kvRow(_('单次查询超时'), inTimeout)
			]),
			E('div', { 'style': 'margin-top:.8em' }, [
				sbui.btn(_('保存 DNS'), 'cbi-button-apply', sbui.action(function() {
					return save(null);
				}))
			]),
			sbui.hint(_('地址可写 223.5.5.5，也可带端口如 1.1.1.1:853；IPv6 需加方括号 [2606:4700:4700::1111]:853。') +
				_('端口留空则用该协议的默认端口（UDP/TCP 53、DoT/DoQ 853、DoH/DoH3 443）。')),
			sbui.hint(_('国内 DNS 走 direct，国外 DNS 走 proxy。国内建议 UDP（最快）或 DoT；') +
				_('国外建议 DoH（443 端口更容易穿过多变网络）。实测 DoT 与 DoH 延迟相近，差别在噪声范围内。'))
		]));

		this.bodyNode.appendChild(sbui.hint(
			_('保存都会写 /etc/sing-box/config.json：先备份到 backup/，再 sing-box check，失败不落盘。')));

		/* 规则集文件大小 */
		sizeNodes.forEach(function(item) {
			fs.stat(item.path).then(function(st) {
				item.node.textContent = sbui.fmtBytes(st.size);
			}).catch(function() {
				item.node.textContent = _('缺失');
				item.node.style.color = '#c00';
			});
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
