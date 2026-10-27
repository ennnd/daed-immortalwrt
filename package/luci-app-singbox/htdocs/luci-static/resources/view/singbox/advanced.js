'use strict';
'require view';
'require singbox.api as api';
'require singbox.ui as sbui';

return view.extend({
	load: function() {
		return Promise.all([ api.readText(), api.listBackups() ]).then(function(r) {
			return { text: r[0] || '', backups: r[1] || [] };
		});
	},

	render: function(data) {
		this.bodyNode = E('div', {});
		this.textArea = sbui.textarea(data.text, { 'rows': 22, 'wrap': 'off' });

		this.redraw(data.backups);

		return E('div', {}, [
			E('h2', {}, _('高级')),
			sbui.warn(_('这里直接编辑 /etc/sing-box/config.json。保存时会先备份、再 sing-box check，失败不会写入；成功后若服务在运行会自动重启。UI 保存会重写文件，注释会丢。')),
			this.bodyNode
		]);
	},

	reload: function() {
		var self = this;

		return Promise.all([ api.readText(), api.listBackups() ]).then(function(r) {
			self.textArea.value = r[0] || '';
			self.redraw(r[1] || []);
		});
	},

	redraw: function(backups) {
		var self = this;

		while (this.bodyNode.firstChild)
			this.bodyNode.removeChild(this.bodyNode.firstChild);

		this.bodyNode.appendChild(sbui.card(_('config.json'), [
			this.textArea,
			E('div', { 'style': 'margin-top:.8em' }, [
				sbui.btn(_('校验'), '', sbui.action(function() {
					return api.checkText(self.textArea.value).then(function(res) {
						if (res.code === 0)
							sbui.notifyOk(_('sing-box check 通过'));
						else
							throw new Error(String(res.stderr || res.stdout || _('校验失败')).trim());
					});
				})),
				' ',
				sbui.btn(_('保存并应用'), 'cbi-button-apply', sbui.action(function() {
					return api.saveText(self.textArea.value, _('手工编辑')).then(function(res) {
						sbui.notifyOk(res.restarted
							? _('已保存、校验通过并重启服务')
							: _('已保存并校验通过（服务未运行，未重启）'));

						return self.reload();
					});
				})),
				' ',
				sbui.btn(_('放弃修改'), 'cbi-button-reset', sbui.action(function() {
					return self.reload().then(function() {
						sbui.notifyOk(_('已重新读取文件'));
					});
				})),
				' ',
				sbui.btn(_('恢复出厂配置'), 'cbi-button-negative', sbui.action(function() {
					if (!confirm(_('把 config.json 恢复成固件出厂内容？当前内容会先备份。')))
						return Promise.resolve();

					return api.resetFactory().then(function() {
						sbui.notifyOk(_('已恢复出厂配置（内容回到 /rom 里的原始模板，需要重新填节点）'));
						return self.reload();
					});
				}))
			]),
			sbui.hint(_('出厂原件来自 /rom/etc/sing-box/config.json（squashfs 只读层，永远不会被覆盖），所以这个按钮在任何时候都能把配置拉回初始状态。'))
		]));

		this.bodyNode.appendChild(sbui.card(_('备份') + ' (' + backups.length + ')', [
			sbui.table([ _('时间'), _('大小'), _('操作') ],
				backups.map(function(b) {
					return [
						sbui.fmtTime(b.time),
						sbui.fmtBytes(b.size),
						sbui.btn(_('回滚'), '', sbui.action(function() {
							if (!confirm(_('回滚到这个备份？当前内容会先备份。')))
								return Promise.resolve();

							return api.restoreBackup(b.name).then(function() {
								sbui.notifyOk(_('已回滚'));
								return self.reload();
							});
						}))
					];
				}), _('还没有备份（每次保存/回滚前都会自动生成，只保留最近 5 份）'))
		]));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
