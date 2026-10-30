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
		return Promise.all([
			api.readConfig(), this.loadSubs(), api.status(),
			api.readPool(), api.readSelection()
		]).then(function(r) {
			return {
				cfg: r[0].cfg, error: r[0].error, text: r[0].text, subs: r[1], st: r[2],
				pool: r[3], sel: r[4]
			};
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

		return Promise.all([
			api.readConfig(), this.loadSubs(),
			api.readPool(), api.readSelection()
		]).then(function(r) {
			self.data = {
				cfg: r[0].cfg,
				error: r[0].error,
				text: r[0].text,
				subs: r[1],
				st: self.data.st,
				pool: r[2],
				sel: r[3]
			};

			self.redraw();
		});
	},

	redraw: function() {
		while (this.bodyNode.firstChild)
			this.bodyNode.removeChild(this.bodyNode.firstChild);

		this.bodyNode.appendChild(this.buildPool(this.data));
		this.bodyNode.appendChild(this.buildNodes(this.data));
		this.bodyNode.appendChild(this.buildSubs(this.data));
	},

	/* ---------------- 订阅节点池 ---------------- */

	/*
	 * 池子里是订阅里的全部节点，这里是唯一决定“用哪几个”的地方。
	 * 面板只写 nodes.selected.json，再让 singbox-nodes 重建 outbounds ——
	 * 不直接改 config.json，这样定时任务刷新订阅时不会把手动停用的节点装回来。
	 */
	buildPool: function(data) {
		var self = this;
		var pool = (data.pool && data.pool.nodes) || [];
		var enabled = (data.sel && data.sel.enabled) || [];
		var denied  = (data.sel && data.sel.denied)  || [];

		var rows = pool.map(function(n) {
			var on = enabled.indexOf(n.tag) >= 0;
			var decided = on || denied.indexOf(n.tag) >= 0;

			return [
				E('span', { 'style': 'word-break:break-all' }, n.tag),
				n.type,
				core.outboundSummary(n) || '—',
				on ? E('b', {}, _('启用'))
				   : E('span', { 'style': 'opacity:.6' }, decided ? _('停用') : _('未决定')),
				sbui.btn(on ? _('停用') : _('启用'),
					on ? 'cbi-button-reset' : 'cbi-button-action',
					sbui.action(function() {
						return self.toggleNode(n.tag, !on);
					}))
			];
		});

		var upd = (data.pool && data.pool.updated) ? sbui.fmtTime(data.pool.updated * 1000) : _('从未更新');

		return sbui.card(_('订阅节点池') + ' (' + pool.length + ')', [
			sbui.table([ _('名称'), _('类型'), _('地址 / 参数'), _('状态'), _('操作') ], rows,
				_('节点池是空的。先在下面添加订阅并点「立即更新」，或等定时任务拉取。')),
			sbui.hint(_('订阅只负责把节点放进池子，这里决定用哪几个。停用后会记住，订阅刷新不会再装回来。池子更新时间：') + upd)
		]);
	},

	toggleNode: function(tag, on) {
		var self = this;

		return api.readSelection().then(function(sel) {
			sel.enabled = sel.enabled.filter(function(t) { return t !== tag; });
			sel.denied  = sel.denied.filter(function(t) { return t !== tag; });

			if (on)
				sel.enabled.push(tag);
			else
				sel.denied.push(tag);

			return api.writeSelection(sel);
		}).then(function() {
			return api.nodesCmd([ 'apply' ]);
		}).then(function() {
			return self.reload();
		}).then(function() {
			sbui.notifyOk(on ? _('已启用并应用') : _('已停用并应用'));
		});
	},

	/* ---------------- 节点 ---------------- */

	buildNodes: function(data) {
		var self = this;
		var nodes = core.proxyNodes(data.cfg);
		var ph = core.scanPlaceholders(data.cfg);
		var phTags = ph.map(function(p) { return p.tag; });

		var rows = nodes.map(function(n) {
			var todo = phTags.indexOf(n.tag) >= 0;

			return [
				todo ? E('span', {}, [ n.tag + ' ', sbui.warn(_('待填写')) ]) : n.tag,
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

		var actions = [
			sbui.btn(_('添加节点'), 'cbi-button-apply', sbui.action(function() {
				self.editNode(null);
			}))
		];

		if (ph.length) {
			actions.push(' ');
			actions.push(sbui.btn(_('删除演示节点') + ' (' + ph.length + ')', 'cbi-button-reset',
				sbui.action(function() {
					return self.removeDemoNodes(ph);
				})));
		}

		var card = sbui.card(_('当前生效的节点') + ' (' + nodes.length + ')', [
			ph.length
				? sbui.warn(_('这些节点还是出厂演示值，sing-box 会拒绝启动：') + core.placeholderText(ph))
				: '',
			sbui.table([ _('名称'), _('类型'), _('地址 / 参数'), _('操作') ], rows,
				_('还没有节点。可以手工添加，或在下面粘贴订阅链接批量导入。')),
			E('div', { 'style': 'margin-top:1em' }, actions),
			sbui.hint(_('这一栏是最终写进 config.json 的节点，由「订阅节点池」的启用状态 + 手工节点合成，') +
				_('由 /usr/bin/singbox-nodes 生成（check 通过才替换，失败自动回滚）。') +
				_('订阅节点请在上面启用/停用，不要在这里改。'))
		]);

		return card;
	},

	/* 一次性清掉出厂演示节点（值里带 YOUR_ 的那些），并顺手修好 members */
	removeDemoNodes: function(ph) {
		var self = this;

		if (!confirm(_('确定删除这 ') + ph.length + _(' 个未填写的演示节点吗？') + '\n' + core.placeholderText(ph)))
			return Promise.resolve();

		return api.readConfig().then(function(r) {
			if (r.error)
				throw new Error(_('当前 config.json 不是合法 JSON：') + r.error);

			ph.forEach(function(p) {
				if (p.where === 'outbound' && p.tag)
					core.removeOutbound(r.cfg, p.tag);
			});

			core.normalizeMembers(r.cfg);

			return api.saveConfig(r.cfg, _('删除演示节点')).then(function() {
				return self.reload();
			}).then(function() {
				sbui.notifyOk(_('已删除 ') + ph.length + _(' 个演示节点'));
			});
		});
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
				var pbk = core.trimStr(f.pbk.value);
				var sid = core.trimStr(f.sid.value);

				if (!pbk)
					throw new Error(_('Reality 需要 public_key'));

				/* sing-box 只会说 invalid public_key，先在这里挡住 */
				if (!core.realityKeyOk(pbk))
					throw new Error(_('Reality 公钥必须是 43 位 base64url 字符（当前 ') + pbk.length +
						_(' 位）。可在路由器执行 sing-box generate reality-keypair 生成一对'));

				if (!core.shortIdOk(sid))
					throw new Error(_('Reality short_id 必须是偶数位十六进制（最多 16 位），当前：') + (sid || '（空）'));

				node.tls.utls = { enabled: true, fingerprint: core.trimStr(f.fp.value) || 'chrome' };
				node.tls.reality = {
					enabled: true,
					public_key: pbk,
					short_id: sid
				};
			}
			else if (f.fp.value) {
				node.tls.utls = { enabled: true, fingerprint: core.trimStr(f.fp.value) };
			}
		}

		var self = this;

		/* 手工节点写进 selected.manual，config.json 由 singbox-nodes 统一生成 */
		return api.readPool().then(function(pool) {
			var inPool = (pool.nodes || []).some(function(n) { return n.tag === tag; });

			if (inPool)
				throw new Error(_('这个节点来自订阅，不能直接编辑。请改订阅内容，或用「启用 / 停用」控制它。'));

			return api.readSelection();
		}).then(function(sel) {
			sel.manual = (sel.manual || []).filter(function(n) { return n.tag !== tag; });
			sel.manual.push(node);

			return api.writeSelection(sel);
		}).then(function() {
			return api.nodesCmd([ 'apply' ]);
		});
	},

	deleteNode: function(tag) {
		var self = this;
		var inPool = ((this.data.pool && this.data.pool.nodes) || []).some(function(n) { return n.tag === tag; });

		if (!confirm(inPool
			? _('确定停用节点 ') + tag + _(' 吗？它会留在订阅池里，随时可以再启用。')
			: _('确定删除手工节点 ') + tag + _(' 吗？')))
			return Promise.resolve();

		/* 订阅节点走“停用”，手工节点才真的删 —— 否则下次订阅刷新又会长回来 */
		if (inPool)
			return this.toggleNode(tag, false);

		return api.readSelection().then(function(sel) {
			sel.manual = sel.manual.filter(function(n) { return n.tag !== tag; });

			return api.writeSelection(sel);
		}).then(function() {
			return api.nodesCmd([ 'apply' ]);
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
							(res.removedDemo && res.removedDemo.length
								? _('，并清掉 ') + res.removedDemo.length + _(' 个未填写的演示节点')
								: '') +
							(res.fixes.length ? _('，修正 ') + res.fixes.length + _(' 处成员引用') : ''));
						return self.reload();
					});
				}))
			])
		]);
	},

	applyParsed: function(idx, parsed, syncMembers) {
		var self = this;
		var incoming = (parsed && parsed.nodes) || [];
		var added = [], replaced = [];

		/* 订阅只更新池子：同 tag 覆盖，新 tag 追加。用不用由选择状态决定。 */
		return api.readPool().then(function(pool) {
			var nodes = (pool.nodes || []).slice();
			var idxOf = {};

			nodes.forEach(function(n, i) { idxOf[n.tag] = i; });

			incoming.forEach(function(n) {
				if (idxOf[n.tag] != null) {
					nodes[idxOf[n.tag]] = n;
					replaced.push(n.tag);
				}
				else {
					idxOf[n.tag] = nodes.length;
					nodes.push(n);
					added.push(n.tag);
				}
			});

			return api.writePool(nodes);
		}).then(function() {
			/* 新节点按 subscription.filter 定默认值；已经选择过的节点不受影响 */
			return api.nodesCmd([ 'auto' ]);
		}).then(function() {
			return api.nodesCmd([ 'apply' ]);
		}).then(function() {
			self.data.subs.settings.sync_members = syncMembers !== false;

			var sub = self.data.subs.subscriptions[idx];

			if (sub) {
				sub.last_update = Date.now();
				sub.count = incoming.length;
			}

			return self.saveSubs(self.data.subs);
		}).then(function() {
			return { added: added, replaced: replaced, removedDemo: [], fixes: [] };
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
