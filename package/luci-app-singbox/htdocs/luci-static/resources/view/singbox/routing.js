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
					return list[i].server || fallback;
			}

			return fallback;
		};

		var inCn = sbui.input(getServer('dns_cn', '223.5.5.5'));
		var inProxy = sbui.input(getServer('dns_proxy', '1.1.1.1'));
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

				var setServer = function(tag, type, server) {
					for (var i = 0; i < c.dns.servers.length; i++) {
						if (c.dns.servers[i].tag === tag) {
							c.dns.servers[i].type = type;
							c.dns.servers[i].server = server;
							c.dns.servers[i].detour = (tag === 'dns_cn') ? 'direct' : 'proxy';
							return;
						}
					}

					c.dns.servers.push({
						tag: tag,
						type: type,
						server: server,
						detour: (tag === 'dns_cn') ? 'direct' : 'proxy'
					});
				};

				var cnVal = core.trimStr(inCn.value);
				var proxyVal = core.trimStr(inProxy.value);

				if (!cnVal || !proxyVal)
					throw new Error(_('DNS 服务器地址不能为空'));

				setServer('dns_cn', 'udp', cnVal);
				setServer('dns_proxy', 'https', proxyVal);

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

		var rsRows = ruleSets.map(function(rs) {
			var sizeNode = E('span', { 'style': 'opacity:.8' }, '…');

			if (rs.path)
				sizeNodes.push({ node: sizeNode, path: rs.path });

			return [
				rs.tag || '—',
				E('span', { 'style': 'word-break:break-all;font-size:90%' }, rs.path || rs.url || '—'),
				sizeNode,
				sbui.btn(_('更新'), '', sbui.action(function() {
					return api.updateRuleSet(rs.tag).then(function(res) {
						sbui.notifyOk(rs.tag + _(' 已更新，') + sbui.fmtBytes(res.size));
						return self.reload();
					});
				}))
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
			sbui.hint(_('只支持 geosite-cn / geoip-cn 的自动更新（从 SagerNet 官方仓库下载 .srs，小于 100KB 视为失败并删除）。'))
		]));

		this.bodyNode.appendChild(sbui.card(_('DNS'), [
			sbui.kvTable([
				sbui.kvRow(_('国内 DNS（UDP 直连）'), inCn),
				sbui.kvRow(_('国外 DNS（DoH 走代理）'), inProxy),
				sbui.kvRow(_('strategy'), selStrategy),
				sbui.kvRow(_('乐观缓存 optimistic'), inOptimistic),
				sbui.kvRow(_('单次查询超时'), inTimeout)
			]),
			E('div', { 'style': 'margin-top:.8em' }, [
				sbui.btn(_('保存 DNS'), 'cbi-button-apply', sbui.action(function() {
					return save(null);
				}))
			])
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
