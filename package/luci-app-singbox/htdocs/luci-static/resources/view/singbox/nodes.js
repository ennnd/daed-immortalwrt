'use strict';
'require view';
'require fs';
'require ui';
'require singbox.api as api';
'require singbox.core as core';
'require singbox.ui as sbui';

var SUBS = '/etc/sing-box/subscriptions.json';

var TYPE_FIELDS = {
	vless:       [ 'uuid', 'flow', 'security', 'sni', 'fp', 'pbk', 'sid' ],
	vmess:       [ 'uuid', 'security', 'sni' ],
	trojan:      [ 'password', 'sni' ],
	shadowsocks: [ 'method', 'password' ],
	hysteria2:   [ 'password', 'sni', 'obfs' ],
	tuic:        [ 'uuid', 'password', 'sni', 'cc' ]
};

return view.extend({
	load: function() {
		return Promise.all([ api.readConfig(), this.loadSubs(), api.status() ])
			.then(function(r) {
				return { cfg: r[0].cfg, error: r[0].error, text: r[0].text, subs: r[1], st: r[2] };
			});
	},

	loadSubs: function() {
		return fs.read(SUBS).then(function(text) {
			var o = null;

			try { o = JSON.parse(text); } catch (e) { o = null; }

			if (!o || typeof o !== 'object')
				o = {};

			if (!Array.isArray(o.subscriptions))
				o.subscriptions = [];

			if (!o.settings)
				o.settings = { sync_members: true, ua: 'v2rayN/6.0' };

			return o;
		}).catch(function() {
			return { subscriptions: [], settings: { sync_members: true, ua: 'v2rayN/6.0' } };
		});
	},

	saveSubs: function(subs) {
		return fs.write(SUBS, JSON.stringify(subs, null, 2) + '\n');
	},

	render: function(data) {
		this.data = data;
		this.bodyNode = E('div', {});

		if (data.error)
			this.bodyNode.appendChild(sbui.warn(_('config.json 解析失败：') + data.error));

		this.redraw();

		return E('div', {}, [
			E('h2', {}, _('节点与订阅')),
			this.bodyNode
		]);
	},

	reload: function() {
		var self = this;

		return Promise.all([ api.readConfig(), this.loadSubs() ]).then(function(r) {
			self.data = {
				cfg: r[0].cfg,
				error: r[0].error,
				text: r[0].text,
				subs: r[1],
				st: self.data.st
			};

			self.redraw();
		});
	},

	redraw: function() {
		while (this.bodyNode.firstChild)
			this.bodyNode.removeChild(this.bodyNode.firstChild);

		this.bodyNode.appendChild(this.buildNodes(this.data));
		this.bodyNode.appendChild(this.buildSubs(this.data));
	},

	/* ---------------- 节点 ---------------- */

	buildNodes: function(data) {
		var self = this;
		var nodes = core.proxyNodes(data.cfg);

		var rows = nodes.map(function(n) {
			return [
				n.tag,
				n.type,
				core.outboundSummary(n) || '—',
				E('span', {}, [
					sbui.btn(_('编辑'), 'cbi-button-action', sbui.action(function() {
						self.editNode(n);
					})),
					' ',
					sbui.btn(_('删除'), 'cbi-button-reset', sbui.action(function() {
						return self.deleteNode(n.tag);
					}))
				])
			];
		});

		return sbui.card(_('节点') + ' (' + nodes.length + ')', [
			sbui.table([ _('名称'), _('类型'), _('地址 / 参数'), _('操作') ], rows,
				_('还没有节点。可以手工添加，或在下面粘贴订阅链接批量导入。')),
			E('div', { 'style': 'margin-top:1em' }, [
				sbui.btn(_('添加节点'), 'cbi-button-apply', sbui.action(function() {
					self.editNode(null);
				}))
			]),
			sbui.hint(_('这里的每个改动都会重写 /etc/sing-box/config.json：先备份到 backup/，再 sing-box check，通过后才替换并重启。注释会丢。'))
		]);
	},

	fieldRow: function(title, node) {
		return E('div', { 'style': 'margin:.5em 0' }, [
			E('div', { 'style': 'font-size:85%;opacity:.75' }, title),
			node
		]);
	},

	editNode: function(node) {
		var self = this;
		var f = {};
		var isNew = !node;

		var typeSel = sbui.select([ 'vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic' ],
			node ? node.type : 'vless', { 'change': function() { syncRows(); } });

		f.type = typeSel;
		f.tag = sbui.input(node ? node.tag : '');
		f.server = sbui.input(node ? node.server : '');
		f.port = sbui.input(node ? node.server_port : '443');
		f.uuid = sbui.input(node ? (node.uuid || '') : '');
		f.password = sbui.input(node ? (node.password || '') : '');
		f.method = sbui.input(node ? (node.method || 'aes-256-gcm') : 'aes-256-gcm');
		f.flow = sbui.select([ '', 'xtls-rprx-vision' ], node ? (node.flow || '') : '', {});
		f.security = sbui.select([ 'reality', 'tls', 'none' ],
			node && node.tls && node.tls.reality ? 'reality' : (node && node.tls ? 'tls' : 'none'), {});
		f.sni = sbui.input(node && node.tls ? (node.tls.server_name || '') : '');
		f.fp = sbui.input(node && node.tls && node.tls.utls ? (node.tls.utls.fingerprint || '') : 'chrome');
		f.pbk = sbui.input(node && node.tls && node.tls.reality ? (node.tls.reality.public_key || '') : '');
		f.sid = sbui.input(node && node.tls && node.tls.reality ? (node.tls.reality.short_id || '') : '');
		f.insecure = sbui.checkbox(node && node.tls && node.tls.insecure ? true : false, {});
		f.obfs = sbui.input(node && node.obfs ? (node.obfs.password || '') : '');

		var rows = {
			uuid: self.fieldRow(_('UUID'), f.uuid),
			password: self.fieldRow(_('密码'), f.password),
			method: self.fieldRow(_('加密方式'), f.method),
			flow: self.fieldRow(_('flow（仅 Reality/TLS 时有效）'), f.flow),
			security: self.fieldRow(_('TLS 模式'), f.security),
			sni: self.fieldRow(_('SNI'), f.sni),
			fp: self.fieldRow(_('uTLS 指纹'), f.fp),
			pbk: self.fieldRow(_('Reality 公钥'), f.pbk),
			sid: self.fieldRow(_('Reality short_id'), f.sid),
			obfs: self.fieldRow(_('Hy2 obfs 密码（可选）'), f.obfs)
		};

		var advanced = E('div', { 'style': 'margin-top:.6em' }, [
			self.fieldRow(_('跳过证书校验'), f.insecure)
		]);

		var dyn = E('div', {});

		var syncRows = function() {
			var t = f.type.value;
			var want = TYPE_FIELDS[t] || [];

			while (dyn.firstChild)
				dyn.removeChild(dyn.firstChild);

			want.forEach(function(k) {
				if (rows[k])
					dyn.appendChild(rows[k]);
			});

			advanced.style.display = (t === 'vless' || t === 'hysteria2' || t === 'tuic') ? '' : 'none';
			f.flow.disabled = (t !== 'vless');
		};

		syncRows();

		var dlg = sbui.modal(isNew ? _('添加节点') : _('编辑节点') + ': ' + node.tag, [
			self.fieldRow(_('名称 tag（重名会覆盖）'), f.tag),
			self.fieldRow(_('类型'), f.type),
			self.fieldRow(_('服务器'), f.server),
			self.fieldRow(_('端口'), f.port),
			dyn,
			advanced,
			E('div', { 'style': 'margin-top:1em' }, [
				sbui.btn(_('保存'), 'cbi-button-apply', sbui.action(function() {
					return self.saveNode(f, node).then(function() {
						ui.hideModal();
						return self.reload();
					}).then(function() {
						sbui.notifyOk(_('已保存并应用'));
					});
				}))
			])
		]);

		return dlg;
	},

	saveNode: function(f, oldNode) {
		var tag = core.trimStr(f.tag.value);
		var type = f.type.value;
		var server = core.trimStr(f.server.value);
		var port = parseInt(f.port.value, 10);

		if (!tag)
			throw new Error(_('名称不能为空'));

		if (!server)
			throw new Error(_('服务器不能为空'));

		if (!port || port < 1 || port > 65535)
			throw new Error(_('端口不合法'));

		var node = { type: type, tag: tag, server: server, server_port: port };

		var need = function(cond, msg) {
			if (!cond)
				throw new Error(msg);
		};

		if (type === 'vless') {
			node.uuid = core.trimStr(f.uuid.value);
			need(node.uuid, _('VLESS 需要 UUID'));

			var flow = f.flow.value;

			if (flow)
				node.flow = flow;
		}
		else if (type === 'vmess') {
			node.uuid = core.trimStr(f.uuid.value);
			node.alter_id = 0;
			node.security = 'auto';
			need(node.uuid, _('VMess 需要 UUID'));
		}
		else if (type === 'trojan' || type === 'hysteria2') {
			node.password = f.password.value;
			need(node.password, _('这个类型需要密码'));
		}
		else if (type === 'shadowsocks') {
			node.method = core.trimStr(f.method.value);
			node.password = f.password.value;
			need(node.method && node.password, _('Shadowsocks 需要加密方式与密码'));
		}
		else if (type === 'tuic') {
			node.uuid = core.trimStr(f.uuid.value);
			node.password = f.password.value;
			node.congestion_control = 'bbr';
			need(node.uuid && node.password, _('TUIC 需要 UUID 与密码'));
		}

		if (type === 'hysteria2' && f.obfs.value) {
			node.obfs = { type: 'salamander', password: f.obfs.value };
		}

		/* TLS */
		var sec = (type === 'trojan' || type === 'hysteria2' || type === 'tuic') ? 'tls' : f.security.value;

		/* VMess 不支持 Reality，界面上误选时降级为普通 TLS */
		if (type === 'vmess' && sec === 'reality')
			sec = 'tls';

		if (sec && sec !== 'none') {
			node.tls = { enabled: true };

			if (f.sni.value)
				node.tls.server_name = core.trimStr(f.sni.value);

			if (f.insecure.checked)
				node.tls.insecure = true;

			if (sec === 'reality') {
				if (!f.pbk.value)
					throw new Error(_('Reality 需要 public_key'));

				node.tls.utls = { enabled: true, fingerprint: core.trimStr(f.fp.value) || 'chrome' };
				node.tls.reality = {
					enabled: true,
					public_key: core.trimStr(f.pbk.value),
					short_id: core.trimStr(f.sid.value)
				};
			}
			else if (f.fp.value) {
				node.tls.utls = { enabled: true, fingerprint: core.trimStr(f.fp.value) };
			}
		}

		var self = this;

		return api.readConfig().then(function(r) {
			if (r.error)
				throw new Error(_('当前 config.json 不是合法 JSON：') + r.error);

			var res = core.mergeNodes(r.cfg, [ node ], { syncMembers: true });

			return api.saveConfig(r.cfg, _('保存节点') + ' ' + tag).then(function() {
				return res;
			});
		});
	},

	deleteNode: function(tag) {
		var self = this;

		if (!confirm(_('确定删除节点 ') + tag + _(' 吗？')))
			return Promise.resolve();

		return api.readConfig().then(function(r) {
			if (r.error)
				throw new Error(_('当前 config.json 不是合法 JSON：') + r.error);

			var res = core.removeOutbound(r.cfg, tag);

			if (!res.removed)
				throw new Error(res.fixes.join('; ') || _('没找到这个节点'));

			return api.saveConfig(r.cfg, _('删除节点') + ' ' + tag);
		}).then(function() {
			return self.reload();
		}).then(function() {
			sbui.notifyOk(_('已删除并应用'));
		});
	},

	/* ---------------- 订阅 ---------------- */

	buildSubs: function(data) {
		var self = this;
		var subs = data.subs.subscriptions;

		var rows = subs.map(function(s, idx) {
			return [
				E('span', { 'style': 'word-break:break-all' }, s.url),
				s.last_update
					? sbui.fmtTime(s.last_update) + (s.count != null ? ' · ' + s.count + ' ' + _('个节点') : '')
					: _('未更新'),
				E('span', {}, [
					sbui.btn(_('立即更新'), 'cbi-button-action', sbui.action(function() {
						return self.updateSubscription(idx);
					})),
					' ',
					sbui.btn(_('删除'), 'cbi-button-reset', sbui.action(function() {
						return self.removeSubscription(idx);
					}))
				])
			];
		});

		return sbui.card(_('订阅'), [
			sbui.table([ _('订阅地址'), _('上次更新'), _('操作') ], rows,
				_('还没有订阅。支持 base64 编码的 URI 列表、明文 URI 列表、以及 sing-box 配置 JSON；Clash YAML 不支持。')),
			E('div', { 'style': 'margin-top:1em' }, [
				sbui.btn(_('添加订阅'), 'cbi-button-apply', sbui.action(function() {
					return self.addSubscription();
				}))
			]),
			sbui.hint(_('更新流程：下载 → 解析 → 预览（显示跳过原因）→ 确认后写入 outbounds。同 tag 覆盖，新 tag 追加。'))
		]);
	},

	addSubscription: function() {
		var self = this;
		var url = sbui.input('', { 'placeholder': 'https://example.com/sub?token=...', 'style': 'width:100%' });
		var ua = sbui.input(this.data.subs.settings.ua || 'v2rayN/6.0', { 'style': 'width:100%' });

		sbui.modal(_('添加订阅'), [
			this.fieldRow(_('订阅地址'), url),
			this.fieldRow(_('User-Agent'), ua),
			sbui.hint(_('UA 决定服务端返回什么格式。v2rayN/6.0 一般会拿到 base64 URI 列表，最通用。')),
			E('div', { 'style': 'margin-top:1em' }, [
				sbui.btn(_('保存'), 'cbi-button-apply', sbui.action(function() {
					var u = core.trimStr(url.value);

					if (!/^https?:\/\//i.test(u))
						throw new Error(_('订阅地址必须是 http(s)://'));

					self.data.subs.subscriptions.push({
						url: u,
						ua: core.trimStr(ua.value) || 'v2rayN/6.0',
						last_update: null,
						count: null
					});

					return self.saveSubs(self.data.subs).then(function() {
						ui.hideModal();
						return self.reload();
					});
				}))
			])
		]);
	},

	removeSubscription: function(idx) {
		var self = this;
		var sub = this.data.subs.subscriptions[idx];

		if (!sub || !confirm(_('确定删除这个订阅吗？（不会删除已经导入的节点）')))
			return Promise.resolve();

		this.data.subs.subscriptions.splice(idx, 1);

		return this.saveSubs(this.data.subs).then(function() {
			return self.reload();
		});
	},

	updateSubscription: function(idx) {
		var self = this;
		var sub = this.data.subs.subscriptions[idx];

		if (!sub)
			return Promise.resolve();

		sbui.modal(_('正在下载订阅…'), [ E('p', {}, sub.url) ]);

		return api.fetchSubscription(sub.url, sub.ua).then(function(text) {
			var parsed = core.parseSubscription(text);

			if (!parsed.nodes.length) {
				var why = core.summarizeSkipped(parsed.skipped)
					.map(function(s) { return s.text + ' × ' + s.count; }).join('；');

				throw new Error(parsed.format === 'empty'
					? _('没有解析出可用节点：内容既不是 URI 列表，也不是 sing-box JSON（Clash YAML 不支持）')
					: _('解析出的节点全是当前固件不支持的：') + why);
			}

			ui.hideModal();

			return self.previewAndApply(idx, parsed);
		}).catch(function(err) {
			ui.hideModal();
			throw err;
		});
	},

	previewAndApply: function(idx, parsed) {
		var self = this;
		var sub = this.data.subs.subscriptions[idx];
		var skipped = core.summarizeSkipped(parsed.skipped);
		var syncCb = sbui.checkbox(this.data.subs.settings.sync_members !== false, {});

		var rows = parsed.nodes.slice(0, 15).map(function(n) {
			return [ n.tag, n.type, core.outboundSummary(n) || '—' ];
		});

		var skipNodes = skipped.map(function(s) {
			return E('li', {}, s.text + ' × ' + s.count +
				(s.samples && s.samples.length
					? E('span', { 'style': 'opacity:.6;font-size:90%' }, ' (' + s.samples[0] + '…)')
					: ''));
		});

		sbui.modal(_('订阅预览'), [
			E('p', {}, [
				_('识别到 '), E('b', {}, String(parsed.nodes.length)), _(' 个节点'),
				skipped.length ? E('span', {}, [ _('，跳过 '), E('b', {}, String(skipped.reduce(function(a, s) { return a + s.count; }, 0))), _(' 个') ]) : ''
			]),
			sbui.table([ _('名称'), _('类型'), _('地址 / 参数') ], rows,
				_('没有可显示的行')),
			parsed.nodes.length > 15
				? E('p', { 'style': 'opacity:.7' }, _('（只显示前 15 个）'))
				: '',
			skipNodes.length
				? E('div', { 'style': 'margin-top:.8em' }, [
					E('b', {}, _('跳过原因：')),
					E('ul', { 'style': 'margin:.3em 0 0 1.2em' }, skipNodes)
				])
				: '',
			E('div', { 'style': 'margin-top:.8em' }, [
				syncCb, ' ', _('把新节点同步加入 selector / urltest 成员列表')
			]),
			E('div', { 'style': 'margin-top:1em' }, [
				sbui.btn(_('写入配置'), 'cbi-button-apply', sbui.action(function() {
					return self.applyParsed(idx, parsed, syncCb.checked).then(function(res) {
						ui.hideModal();
						sbui.notifyOk(_('已写入 ') + res.added.length + _(' 个新节点，覆盖 ') + res.replaced.length + _(' 个') +
							(res.fixes.length ? _('，修正 ') + res.fixes.length + _(' 处成员引用') : ''));
						return self.reload();
					});
				}))
			])
		]);
	},

	applyParsed: function(idx, parsed, syncMembers) {
		var self = this;

		return api.readConfig().then(function(r) {
			if (r.error)
				throw new Error(_('当前 config.json 不是合法 JSON：') + r.error);

			var res = core.mergeNodes(r.cfg, parsed.nodes, { syncMembers: syncMembers !== false });

			return api.saveConfig(r.cfg, _('订阅更新')).then(function() {
				self.data.subs.settings.sync_members = syncMembers !== false;

				var sub = self.data.subs.subscriptions[idx];

				if (sub) {
					sub.last_update = Date.now();
					sub.count = parsed.nodes.length;
				}

				return self.saveSubs(self.data.subs);
			}).then(function() {
				return res;
			});
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
