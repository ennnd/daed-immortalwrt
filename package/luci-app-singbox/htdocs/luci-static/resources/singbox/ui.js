'use strict';
'require baseclass';
/* luci-app-singbox 的界面小工具（只依赖 LuCI 的 ui 与全局 E/_） */
'require ui';
'require singbox.core as core';

var fmtTime = function(ms) {
	if (!ms)
		return '—';

	var d = new Date(ms);

	function p(n) { return (n < 10 ? '0' : '') + n; }

	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
		p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

var fmtBytes = function(n) {
	if (!n && n !== 0)
		return '—';

	if (n < 1024)
		return n + ' B';

	if (n < 1024 * 1024)
		return (n / 1024).toFixed(1) + ' KB';

	return (n / 1024 / 1024).toFixed(1) + ' MB';
};

var notify = function(title, msg, cls) {
	ui.addNotification(title, E('p', {}, msg), cls || 'info');
};

var notifyError = function(err) {
	var msg = String((err && err.message) || err || '未知错误');

	ui.addNotification(_('操作失败'), [
		E('pre', { 'style': 'white-space:pre-wrap;max-height:14em;overflow:auto' }, msg)
	], 'danger');
};

var notifyOk = function(msg) {
	ui.addNotification(null, E('p', {}, msg), 'success');
};

var btn = function(label, cls, handler) {
	return E('button', {
		'class': 'btn cbi-button ' + (cls || 'cbi-button-action'),
		'click': handler
	}, [ label ]);
};

/* 卡片：[标题 + 右侧操作] + 内容 */
var card = function(title, children, actions) {
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, [
			E('span', {}, title || ''),
			actions ? E('span', { 'style': 'float:right' }, actions) : ''
		]),
		E('div', { 'class': 'cbi-section-node' }, children)
	]);
};

var kvRow = function(k, v, style) {
	/*
	 * 注意：v 可能是「字符串 / 单个 DOM 节点 / 节点数组」三者之一。
	 * 必须直接把 v 作为 children 传入，不能包成 [v]——否则当 v 本身是
	 * 数组（如 [徽章, ' ', 说明span]）会形成嵌套数组，本版本 LuCI 的 E
	 * 对嵌套数组不会递归展开，而是对数组调用 toString()，把每个 DOM 节点
	 * 打成 "[object HTMLSpanElement]"。
	 * v 为 null/undefined 时 LuCI 的 E 会跳过，td 留空（与旧行为一致）。
	 */
	return E('tr', {}, [
		E('td', { 'class': 'th', 'style': 'width:34%;white-space:nowrap' }, k),
		E('td', { 'style': style || '' }, v)
	]);
};

var kvTable = function(rows) {
	return E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]);
};

/* headers: 字符串数组；rows: 二维数组，元素可以是节点或字符串 */
var table = function(headers, rows, emptyText) {
	if (!rows.length)
		return E('p', { 'style': 'opacity:.7' }, emptyText || _('暂无数据'));

	return E('table', { 'class': 'table' }, [
		E('thead', {}, [ E('tr', {}, headers.map(function(h) {
			return E('th', {}, h);
		})) ]),
		E('tbody', {}, rows.map(function(r) {
			return E('tr', {}, r.map(function(c, i) {
				return E('td', { 'style': (i === 0 ? '' : 'white-space:nowrap') },
					[ (c == null) ? '' : c ]);
			}));
		}))
	]);
};

var label = function(text) {
	return E('label', { 'class': 'cbi-value-title' }, text);
};

var input = function(value, attrs) {
	var a = { 'class': 'cbi-input-text', 'value': (value == null ? '' : value) };

	for (var k in (attrs || {}))
		a[k] = attrs[k];

	return E('input', a);
};

var select = function(options, value, attrs) {
	var a = { 'class': 'cbi-input-select' };

	for (var k in (attrs || {}))
		a[k] = attrs[k];

	return E('select', a, options.map(function(o) {
		var v = (typeof o === 'string') ? o : o.value;
		var t = (typeof o === 'string') ? o : o.label;

		return E('option', { 'value': v, 'selected': (String(v) === String(value)) ? 'selected' : null }, t);
	}));
};

var checkbox = function(checked, attrs) {
	var a = { 'type': 'checkbox', 'checked': checked ? 'checked' : null };

	for (var k in (attrs || {}))
		a[k] = attrs[k];

	return E('input', a);
};

var textarea = function(value, attrs) {
	var a = {
		'class': 'cbi-input-textarea',
		'style': 'width:100%;font-family:monospace;font-size:12px',
		'rows': 20,
		'spellcheck': 'false'
	};

	for (var k in (attrs || {}))
		a[k] = attrs[k];

	return E('textarea', a, [ value == null ? '' : value ]);
};

var badge = function(text, kind) {
	var color = { ok: '#0a0', bad: '#c00', warn: '#b60' }[kind || 'ok'];

	return E('span', {
		'style': 'display:inline-block;padding:1px 8px;border-radius:9px;color:#fff;background:' + color
	}, text);
};

var hint = function(text) {
	return E('p', { 'style': 'opacity:.75;font-size:90%;margin:.4em 0 0' }, text);
};

var warn = function(text) {
	return E('div', {
		'class': 'alert-message warning',
		'style': 'margin:.6em 0'
	}, [ E('p', {}, text) ]);
};

/* 把异步动作做成"点了变灰、结束恢复"，并统一处理错误。
   handler 里 throw 的 Error 会以通知形式显示，不会冒泡成未捕获异常。 */
var action = function(fn) {
	return function(ev) {
		var node = ev ? ev.currentTarget : null;

		if (node && node.disabled)
			return;

		if (node)
			node.disabled = true;

		var p;

		try {
			p = Promise.resolve(fn(ev));
		}
		catch (e) {
			p = Promise.reject(e);
		}

		return p.catch(function(err) {
			notifyError(err);
		}).then(function() {
			if (node)
				node.disabled = false;
		});
	};
};

/* 模态框：children 里自己放按钮，关闭用 ui.hideModal() */
var modal = function(title, children) {
	return ui.showModal(title, [
		E('div', {}, children),
		E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
			btn(_('关闭'), '', ui.hideModal)
		])
	]);
};

return baseclass.extend({
	fmtTime: fmtTime,
	fmtBytes: fmtBytes,
	notify: notify,
	notifyOk: notifyOk,
	notifyError: notifyError,
	btn: btn,
	card: card,
	kvRow: kvRow,
	kvTable: kvTable,
	table: table,
	label: label,
	input: input,
	select: select,
	checkbox: checkbox,
	textarea: textarea,
	badge: badge,
	hint: hint,
	warn: warn,
	action: action,
	modal: modal
});
