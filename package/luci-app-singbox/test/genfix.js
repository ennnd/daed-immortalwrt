/* 生成 test/fixtures 下的订阅样例（一次性工具，不打包进固件） */
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node genfix.js <fixtures-dir>'); process.exit(1); }

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

const vmess = b64(JSON.stringify({
	v: '2',
	ps: 'VMess-WS',
	add: 'vm.example.com',
	port: '443',
	id: '11111111-2222-3333-4444-555555555555',
	aid: '0',
	scy: 'auto',
	net: 'ws',
	type: 'none',
	host: 'vm.example.com',
	path: '/ray',
	tls: 'tls',
	sni: 'vm.example.com',
	fp: 'chrome'
}));

const ssAead = b64('aes-256-gcm:pass456');
const ssPlugin = b64('aes-256-gcm:pass456');

const lines = [
	`vmess://${vmess}#VMess-WS`,
	'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@vless.example.com:443?encryption=none&security=reality&sni=www.bing.com&fp=chrome&pbk=AcSDB92IB-REhNbdYjXb_6PjAVzYkHtbrbYDbSqwQ04&sid=ab12&type=tcp&flow=xtls-rprx-vision#VLESS-Reality',
	'trojan://pass123@trojan.example.com:443?sni=trojan.example.com&type=ws&path=%2Fws#Trojan-WS',
	`ss://${ssAead}@ss.example.com:8388#SS-AEAD`,
	`ss://${ssPlugin}@ss2.example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp#SS-Plugin`,
	'hysteria2://pass789@hy2.example.com:443?sni=hy2.example.com&obfs=salamander&obfs-password=obfspass#Hy2',
	'tuic://99999999-8888-7777-6666-555555555555:tuicpass@tuic.example.com:443?congestion_control=bbr&alpn=h3&sni=tuic.example.com#TUIC',
	'vless://cccccccc-dddd-eeee-ffff-000000000000@grpc.example.com:443?security=tls&type=grpc&serviceName=gs&sni=g.example.com#GRPC-Node',
	'ssr://aHR0cHM6Ly9leGFtcGxlLmNvbQ#SSR'
];

const plain = lines.join('\n') + '\n';

fs.writeFileSync(path.join(OUT, 'sub-plain.txt'), plain, 'utf8');
fs.writeFileSync(path.join(OUT, 'sub-base64.txt'), b64(plain) + '\n', 'utf8');

const json = {
	outbounds: [
		{ type: 'vless', tag: 'JSON-Node', server: 'json.example.com', server_port: 443, uuid: 'dddddddd-1111-2222-3333-444444444444', tls: { enabled: true, server_name: 'json.example.com' } },
		{ type: 'shadowsocks', tag: 'JSON-SS', server: 'ss3.example.com', server_port: 8388, method: 'aes-128-gcm', password: 'pw' },
		{ type: 'selector', tag: 'proxy', outbounds: [ 'JSON-Node' ] },
		{ type: 'direct', tag: 'direct' }
	]
};

fs.writeFileSync(path.join(OUT, 'sub-json.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');

console.log('fixtures written to', OUT);
