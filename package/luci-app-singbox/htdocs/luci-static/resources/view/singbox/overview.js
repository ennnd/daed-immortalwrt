'use strict';
'require view';
'require singbox.api as api';
'require singbox.core as core';
'require singbox.ui as sbui';

return view.extend({
	load: function() {
		return Promise.all([ api.status(), api.readText() ]).then(function(r) {
			return { st: r[0], text: r[1] || '' };
		});
	},

	redraw: function(st) {
		this.st = st;

		while (this.bodyNode.firstChild)
			this.bodyNode.removeChild(this.bodyNode.firstChild);

		this.bodyNode.appendChild(this.buildStatus(st));
		this.logNode.textContent = st.log || _('（暂无日志）');
	},

	reload: function() {
		var self = this;

		return api.status().then(function(st) { self.redraw(st); });
	},

	render: function(data) {
		var cfg = null;

		try {
			cfg = core.parseJsonc(data.text || '');
		}
		catch (e) {
			cfg = null;
		}

		this.placeholders = core.scanPlaceholders(cfg);
		this.bodyNode = E('div', {});
		this.logNode = E('pre', {
			'style': 'white-space:pre-wrap;word-break:break-all;max-height:22em;overflow:auto;font-size:11px;margin:0'
		});

		this.redraw(data.st);

		return E('div', {}, [
			E('h2', {}, _('Sing-Box')),
			this.bodyNode,
			sbui.card(_('最近日志'), [
				this.logNode,
				E('div', { 'style': 'margin-top:.8em' }, [
					sbui.btn(_('查看完整日志'), '', sbui.action(function() {
						return api.logTail(120).then(function(log) {
							sbui.modal(_('最近日志'), [
								E('pre', {
									'style': 'white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto;font-size:11px'
								}, log || _('（暂无日志）'))
							]);
						});
					}))
				])
			])
		]);
	},

	buildStatus: function(st) {
		var self = this;

		var rows = [
			sbui.kvRow(_('服务状态'), st.running
				? sbui.badge(_('运行中'), 'ok')
				: sbui.badge(_('未运行'), 'bad')),
			sbui.kvRow(_('进程 PID'), st.pid || '—'),
			sbui.kvRow(_('内核版本'), st.version || '—'),
			sbui.kvRow(_('TUN 接口'), (st.tun && st.tun.length)
				? st.tun.join(', ')
				: _('未发现（服务未运行，或 TUN 入站被关掉）')),
			sbui.kvRow(_('UCI enabled'), st.uci_enabled ? '1' : '0'),
			sbui.kvRow(_('DNS 接管'), [
				st.dns_taken ? sbui.badge(_('已接管'), 'ok') : sbui.badge(_('未接管'), 'warn'),
				' ',
				E('span', { 'style': 'opacity:.75' },
					'(' + _('dnsmasq port') + ': ' + (st.dnsmasq_port == null ? '—' : String(st.dnsmasq_port)) + ')')
			]),
			sbui.kvRow(_('urltest 最近选择'), st.urltest_last || '—',
				'font-family:monospace;font-size:11px;word-break:break-all')
		];

		var actions = [
			sbui.btn(_('启用'), 'cbi-button-apply', sbui.action(function() {
				return api.enable().then(function() {
					sbui.notifyOk(_('已启用：sing-box 运行中，dnsmasq 只做 DHCP，LAN DNS 指向 223.5.5.5'));
					return self.reload();
				});
			})),
			' ',
			sbui.btn(_('停用'), 'cbi-button-reset', sbui.action(function() {
				return api.disable().then(function() {
					sbui.notifyOk(_('已停用：服务已停止，dnsmasq 已恢复监听 53'));
					return self.reload();
				});
			})),
			' ',
			sbui.btn(_('重启'), '', sbui.action(function() {
				return api.restart().then(function(res) {
					if (res.code !== 0)
						throw new Error(String(res.stderr || res.stdout || _('重启失败')).trim());

					return api.sleep(1500);
				}).then(function() {
					return self.reload();
				}).then(function() {
					sbui.notifyOk(_('已重启'));
				});
			})),
			' ',
			sbui.btn(_('刷新'), '', sbui.action(function() { return self.reload(); }))
		];

		var children = [
			sbui.kvTable(rows),
			E('div', { 'style': 'margin-top:1em' }, actions),
			sbui.hint(_('启用会复用 singbox-on 的逻辑：先确认 sing-box 起来了，再让 dnsmasq 交出 DNS（port=0，LAN 走 223.5.5.5）。启动失败自动回滚，dnsmasq 不会被改。'))
		];

		if (this.placeholders.length) {
			children.unshift(sbui.warn(
				_('配置里还有未填的占位符：') + core.placeholderText(this.placeholders) +
				_('。sing-box 会拒绝启动（例如 invalid public_key）。请到「节点与订阅」页填成真实参数，或点「删除演示节点」一键清掉。')));
		}
		else if (!st.running && st.uci_enabled) {
			children.unshift(sbui.warn(
				_('UCI 里 enabled=1 但进程没在跑，可能启动失败过。看下面的日志，或点「重启」重试。')));
		}

		return sbui.card(_('服务状态'), children);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
