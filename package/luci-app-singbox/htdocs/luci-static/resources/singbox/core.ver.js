/*
 * luci-app-singbox 构建版本戳
 *
 * 这个文件的作用只有一个：让浏览器能检测出「自己跑的是旧缓存」。
 *
 * 背景：LuCI 静态资源的 URL 形如
 *     /luci-static/resources/singbox/core.js?v=26
 * 那个 v= 是 LuCI 的主版本号（实测 26），**不随文件内容变化**。
 * 所以我们热部署或升级本包后，浏览器仍会继续用之前缓存下来的旧 JS，
 * 而且因为 URL 没变，普通刷新也拿不到新文件。
 *
 * 面板启动时会用 cache:'no-store' 单独取这个文件，
 * 把里面的 BUILD_ID 与 core.js 里内置的 BUILD_ID 比对：
 * 不一致就说明当前页面跑的是旧缓存，界面会给出强制刷新提示。
 *
 * 改动本包任何前端文件后，请同时更新：
 *   - core.js 里的 BUILD_ID
 *   - 本文件的 BUILD_ID
 *  两者必须一致。
 */
var BUILD_ID = '2026-10-29.4';
