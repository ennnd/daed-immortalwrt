'use strict';
'require view';
'require singbox.api as api';
'require singbox.core as core';
'require singbox.ui as sbui';

return view.extend({
	load: function() {
		return Promise.all([
			api.status(),
			api.readText(),
			/* 顺便检测浏览器是不是在用旧缓存（LuCI 的 ?v= 不随内容变，
			   热部署后浏览器仍会拿旧 JS）。检测失败不影响主流程。 */
			core.checkStaleBuild().catch(function() { return { stale: false }; })
		]).then(function(r) {
			return { st: r[0], text: r[1] || '', stale: r[2] };
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
		this.cfg = cfg;
		this.bodyNode = E('div', {});
		this.logNode = E('pre', {
			'style': 'white-space:pre-wrap;word-break:break-all;max-height:22em;overflow:auto;font-size:11px;margin:0'
		});

		this.redraw(data.st);

		var selCard = this.buildSelector(cfg);

		if (selCard)
			this.bodyNode.appendChild(selCard);

		/* 缓存检测：LuCI 的 ?v= 固定不变，热部署后浏览器仍会用旧 JS。
		   检测到不一致就明确告诉用户"你看到的是旧界面"，并给出强制刷新按钮。 */
		if (data.stale && data.stale.stale) {
			this.bodyNode.appendChild(E('div', { 'style': 'margin-top:1em' }, [
				sbui.warn(_('检测到浏览器正在使用旧版本的界面缓存（服务端版本 ') +
					(data.stale.server || '?') + _('，当前页面版本 ') + core.BUILD_ID + _('）。' +
					'页面上的判断与提示可能已经过时。请强制刷新后再看。')),
				E('div', { 'style': 'margin-top:.5em' }, [
					sbui.btn(_('强制刷新页面'), 'cbi-button-apply', sbui.action(function() {
						/* 绕过 HTTP 缓存重新加载，并清掉可能已缓存的模块 */
						try {
							if (window.caches && window.caches.keys) {
								window.caches.keys().then(function(keys) {
									keys.forEach(function(k) { window.caches.delete(k); });
								});
							}
						} catch (e) { /* 忽略 */ }

						window.location.reload(true);
					}))
				])
			]));
		}

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

	/*
	 * 节点选择卡片：列出 proxy selector 的候选出口（auto + 各节点），
	 * 当前选中的是 default。切换会写入 default 并重启 sing-box 生效。
	 * 没有 proxy selector 时返回 null（UI 不显示）。
	 */
	buildSelector: function(cfg) {
		var self = this;
		var info = core.selectorInfo(cfg, 'proxy');

		if (!info || info.outbounds.length === 0)
			return null;

		var cur = info.current;

		var opts = info.outbounds.map(function(m) {
			return E('option', { value: m, selected: (m === cur) ? 'selected' : null },
				m === 'auto' ? _('自动（延迟最低）') : m);
		});

		var sel = E('select', { 'class': 'cbi-input-select', 'style': 'max-width:14em' }, opts);

		var applyBtn = sbui.btn(_('应用'), 'cbi-button-apply', sbui.action(function() {
			var v = sel.value;

			if (v === cur) {
				sbui.notifyOk(_('当前已是该出口'));
				return;
			}

			return api.selectOutbound('proxy', v).then(function() {
				sbui.notifyOk(_('已切换出口到 ') + v);
				return self.reload();
			}).catch(function(e) {
				sbui.notifyError(String((e && e.message) || e));
				return self.reload();
			});
		}));

		return sbui.card(_('节点选择（出口）'), [
			sbui.kvRow(_('当前出口'), cur === 'auto' ? _('自动（延迟最低）') : cur),
			E('div', { 'style': 'margin:.6em 0' }, [
				E('label', { 'style': 'margin-right:.6em' }, _('选择节点：')),
				sel
			]),
			E('div', {}, applyBtn),
			sbui.hint(_('selector 未启用 Clash API，切换需重启 sing-box 才生效。选 “自动” 则按延迟在节点间择优。'))
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
			sbui.kvRow(_('DNS 路径'), [
				st.dns_via_singbox
					? sbui.badge(_('经 sing-box（国外走 DoH 代理）'), 'ok')
					: sbui.badge(_('直连解析器'), 'warn'),
				' ',
				E('span', { 'style': 'opacity:.75' },
					'(' + _('上游') + ': ' + (st.dns_upstream && st.dns_upstream.length
						? st.dns_upstream.join(', ')
						: _('默认（resolv.conf）')) + ')')
			]),
			sbui.kvRow(_('防火墙区'), st.fw_zone_ok
				? sbui.badge(_('正常'), 'ok')
				: sbui.badge(_('未正确配置'), 'bad')),
			sbui.kvRow(_('IPv6 防护'), st.ipv6_block_ok
				? sbui.badge(_('已阻断（无绕过）'), 'ok')
				: sbui.badge(_('存在 IPv6 绕过'), 'bad')),
			sbui.kvRow(_('urltest 最近选择'), st.urltest_last || '—',
				'font-family:monospace;font-size:11px;word-break:break-all')
		];

		var actions = [
			sbui.btn(_('启用'), 'cbi-button-apply', sbui.action(function() {
				return api.enable().then(function() {
					sbui.notifyOk(_('已启用：sing-box 运行中，防火墙区与 DNS 上游已就绪'));
					return self.reload();
				});
			})),
			' ',
			sbui.btn(_('停用'), 'cbi-button-reset', sbui.action(function() {
				return api.disable().then(function() {
					sbui.notifyOk(_('已停用：服务已停止，DNS 保持直连解析器'));
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
			sbui.hint(_('启用会先建好 singbox 防火墙区（放行 tun0 回程、加上 lan→singbox 转发），' +
				'再把 dnsmasq 的上游 DNS 指向公网解析器，最后才启动 sing-box。' +
				'顺序很重要：防火墙必须早于 sing-box（fw4 reload 会冲掉 TUN 规则）。启动失败会自动回滚。'))
		];

		if (st.dns_taken) {
			children.unshift(sbui.warn(
				_('检测到旧版遗留的 DNS 接管（dnsmasq port=0 + LAN 强制 DNS）。' +
				'这种状态下 sing-box 并不监听 :53，会导致整网无法解析。点「启用」可自动修复。')));
		}

		if (st.dns_upstream_private) {
			children.unshift(sbui.warn(
				_('dnsmasq 的上游 DNS 是内网地址，查询会绕过 TUN，' +
				'国外域名可能被投毒而打不开。点「启用」可自动改成公网解析器。')));
		}

		if (!st.fw_zone_ok) {
			children.unshift(sbui.warn(
				_('singbox 防火墙区未正确配置：') + core.fwProblemText(st.fw_zone_problems) +
				_('。这会导致 LAN 客户端上不了网或代理回程被拒。点「启用」可自动修复。')));
		}

		if (!st.ipv6_block_ok) {
			children.unshift(sbui.warn(
				_('IPv6 绕过防护未就绪：') + core.ipv6ProblemText(st.ipv6_block_problems) +
				_('。本配置的 TUN 只处理 IPv4，若不阻断 LAN 的 IPv6 出网，' +
				'客户端会用真实运营商 IPv6 直连，代理被绕过、真实 IP 泄漏。点「启用」可自动修复。')));
		}

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
