# Persistent Browser Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Uptime Kuma 的 Real Browser 监控中加入可选的、每监控器隔离的持久会话与页面就绪选择器，用于更可靠地验证公共 Web 应用的连续浏览状态。

**Architecture:** 默认继续使用短生命周期的无状态 Browser Context，确保现有行为零变化。仅在监控器显式启用 `browser_persist_session` 时，从每个监控器专属文件加载 Playwright storage state，并在成功完成导航和就绪验证后原子更新；删除监控器时移除该专属 state 文件。`browser_ready_selector` 作为可选的应用就绪条件，避免将中间跳转或仅外壳加载误判为成功。

**Tech Stack:** Node.js、Knex migrations、SQLite/RedBean monitor model、Vue 3、Playwright Core、Node test runner。

## Global Constraints

- 仅支持公开页面的正常浏览会话；不导入用户 Cookie、不会自动登录、不会保存 Hugging Face Token。
- 所有新功能默认关闭，未启用的 Real Browser 监控必须保持原有导航、截图与成功判定行为。
- state 文件必须按 monitor ID 隔离，存放于 Uptime Kuma 数据目录的专用子目录，且不得直接使用用户提供的路径或文件名。
- 只有在导航成功、最终响应为 2xx/3xx、且（如配置）就绪选择器命中时，才写回 state。
- state 文件写入应使用临时文件和 rename，避免进程中断留下半写入 JSON。
- 页面就绪选择器的超时应复用监控超时边界，不得无限等待。
- 不提供用户代理伪造、浏览器指纹规避、CAPTCHA 绕过或凭据自动填充功能。

---

### Task 1: 数据模型、迁移与会话状态路径工具

**Files:**
- Create: `db/knex_migrations/2026-08-12-0000-add-real-browser-session.js`
- Create: `server/monitor-types/real-browser-session-state.js`
- Modify: `server/model/monitor.js:110-205, 1748-1765, monitor 删除清理路径`
- Test: `test/backend-test/test-real-browser-session-state.js`
- Modify: `test/backend-test/test-migration.js`

**Interfaces:**
- Produces `getBrowserSessionStatePath(monitorId): string`，返回数据目录中 `browser-session-states/<monitorId>.json`。
- Produces `loadBrowserSessionState(monitorId): Promise<string | undefined>`，仅在 JSON 文件存在且可解析时返回 state 文件路径；无文件时返回 `undefined`；损坏文件抛出带 monitor ID 的错误。
- Produces `saveBrowserSessionState(context, monitorId): Promise<void>`，先写入 `.<monitorId>.tmp`，再原子 rename 至最终路径。
- Produces `removeBrowserSessionState(monitorId): Promise<void>`，文件不存在时不报错。
- Adds `monitor.browser_persist_session`（boolean，default `false`）和 `monitor.browser_ready_selector`（nullable string）字段。

- [ ] **Step 1: 写出失败的 state 路径与删除测试。**

```javascript
const { test } = require("node:test");
const assert = require("node:assert");
const {
    getBrowserSessionStatePath,
    removeBrowserSessionState,
} = require("../../server/monitor-types/real-browser-session-state");

test("browser session state path uses a monitor-scoped json filename", () => {
    assert.match(getBrowserSessionStatePath(42), /browser-session-states[\\/]42\\.json$/);
});

test("removing a missing browser session state is idempotent", async () => {
    await removeBrowserSessionState(99999999);
});
```

- [ ] **Step 2: 运行测试并确认失败。**

Run: `node --test test/backend-test/test-real-browser-session-state.js`  
Expected: FAIL，因为模块尚不存在。

- [ ] **Step 3: 创建数据库迁移与 session-state 工具。**

```javascript
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.boolean("browser_persist_session").notNullable().defaultTo(false);
        table.text("browser_ready_selector").nullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("browser_persist_session");
        table.dropColumn("browser_ready_selector");
    });
};
```

`real-browser-session-state.js` 必须通过 `Database` 提供的数据目录计算固定子目录，以 `String(monitorId)` 做数字校验，不接受包含斜杠的 ID；写入使用 `context.storageState({ path: tmpPath })` 后 `fs.promises.rename(tmpPath, finalPath)`。

- [ ] **Step 4: 将新字段加入 Monitor 传输对象和保存校验。**

在 `Monitor.toJSON()` 返回 `browserPersistSession: this.getBrowserPersistSession()` 与 `browserReadySelector: this.getBrowserReadySelector()`；增加两个 getter，其中布尔 getter 只在值为 `1` / `true` 时返回 true，选择器 getter 会 trim 字符串并把空字符串归一化为 `null`。在 real-browser 类型校验块中拒绝超过 1024 字符的选择器。

- [ ] **Step 5: 运行 state 与迁移测试。**

Run: `node --test test/backend-test/test-real-browser-session-state.js test/backend-test/test-migration.js`  
Expected: PASS。

- [ ] **Step 6: 提交数据层改动。**

```bash
git add db/knex_migrations/2026-08-12-0000-add-real-browser-session.js \
  server/monitor-types/real-browser-session-state.js \
  server/model/monitor.js \
  test/backend-test/test-real-browser-session-state.js \
  test/backend-test/test-migration.js
git commit -m "feat: add persistent real-browser session settings"
```

### Task 2: Real Browser 运行逻辑与就绪选择器

**Files:**
- Modify: `server/monitor-types/real-browser-monitor-type.js:246-295`
- Test: `test/backend-test/test-real-browser-session-state.js`

**Interfaces:**
- Consumes `monitor.getBrowserPersistSession(): boolean` 和 `monitor.getBrowserReadySelector(): string | null`。
- Consumes state helpers from Task 1。
- Produces `createRealBrowserContext(browser, monitor): Promise<BrowserContext>`，在启用且存在 state 时调用 `browser.newContext({ storageState: statePath })`，否则调用 `browser.newContext()`。
- Produces `assertRealBrowserReady(page, monitor, timeoutMs): Promise<void>`，未配置选择器时立即完成，配置时调用 `page.waitForSelector(selector, { state: "visible", timeout: timeoutMs })`。

- [ ] **Step 1: 编写选择器等待和 state 回写的失败测试。**

```javascript
test("ready selector uses visible state and monitor timeout", async () => {
    const calls = [];
    const page = { waitForSelector: async (...args) => calls.push(args) };
    await assertRealBrowserReady(page, { getBrowserReadySelector: () => "#app-ready" }, 12000);
    assert.deepStrictEqual(calls, [["#app-ready", { state: "visible", timeout: 12000 }]]);
});

test("successful persistent monitor saves its scoped storage state", async () => {
    const calls = [];
    const context = { storageState: async ({ path }) => calls.push(path) };
    await saveBrowserSessionState(context, 7);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0], /\.7\.tmp$/);
});
```

- [ ] **Step 2: 运行测试并确认失败。**

Run: `node --test test/backend-test/test-real-browser-session-state.js`  
Expected: FAIL，因为运行时 helpers 尚未导出。

- [ ] **Step 3: 最小化改造 `RealBrowserMonitorType.check`。**

用 `const timeoutMs = monitor.interval * 1000 * 0.8` 代替内联计算。创建 context 前读取 state：当 `monitor.getBrowserPersistSession()` 为 true 且 state 文件存在时传入 `{ storageState: statePath }`，其他情况保持空 options。保留原有 URL 协议校验、`page.goto(..., { waitUntil: "networkidle", timeout: timeoutMs })`、截图和 2xx/3xx 成功判定。

在 `page.goto` 后调用 `assertRealBrowserReady(page, monitor, timeoutMs)`；只有通过选择器、截图完成且响应状态成功后，才调用 `saveBrowserSessionState(context, monitor.id)`。无论成功或失败都使用 `finally` 调用 `context.close()`。保存失败必须使本次检查失败，防止误报成功。

- [ ] **Step 4: 运行单元测试与现有测试。**

Run: `node --test test/backend-test/test-real-browser-session-state.js test/backend-test/test-monitor-response.js`  
Expected: PASS。

- [ ] **Step 5: 提交浏览器运行逻辑。**

```bash
git add server/monitor-types/real-browser-monitor-type.js \
  test/backend-test/test-real-browser-session-state.js
git commit -m "feat: persist real-browser session state"
```

### Task 3: 编辑界面、翻译和删除清理

**Files:**
- Modify: `src/pages/EditMonitor.vue:1711-1739, 3310-3320`
- Modify: `src/lang/en.json`
- Modify: `src/lang/zh-CN.json`
- Modify: `server/model/monitor.js:monitor deletion method`
- Test: `test/backend-test/test-real-browser-session-state.js`

**Interfaces:**
- Adds two settings only when `monitor.type === "real-browser"`: `browserPersistSession` 与 `browserReadySelector`。
- Uses backend JSON casing consistently with existing `browserPersistSession` / `browserReadySelector` fields.
- On monitor deletion, invokes `removeBrowserSessionState(this.id)` before the monitor row is removed.

- [ ] **Step 1: 增加 UI 组件与翻译键。**

在 Screenshot Delay 控件后增加复选框 `v-model="monitor.browserPersistSession"`，标签为 `Persistent Browser Session`，辅助文案明确“将公开站点的同站 Cookie 和 localStorage 保存在本机；不用于登录或导入凭据”。当复选框开启时显示文本输入 `v-model="monitor.browserReadySelector"`，标签为 `Ready Selector`，placeholder 为 `#app-ready`。

添加英文和简体中文翻译键：`Persistent Browser Session`、`persistentBrowserSessionDescription`、`Ready Selector`、`readySelectorDescription`。文案不得声称能防止供应商休眠。

- [ ] **Step 2: 初始化新 monitor 默认值。**

在 `EditMonitor.vue` 的 `monitor` 默认对象中加入：

```javascript
browserPersistSession: false,
browserReadySelector: null,
```

- [ ] **Step 3: 在删除路径调用 state 清理。**

将 `removeBrowserSessionState(this.id)` 放入 `Monitor` 的删除操作中；清理异常应记录 warning 但不得阻止数据库监控器删除。测试以真实临时 state 文件断言删除监控器后文件不存在。

- [ ] **Step 4: 运行翻译和 backend 测试。**

Run: `pnpm test-backend`  
Expected: PASS。

Run: `pnpm check-languages`  
Expected: PASS。

- [ ] **Step 5: 提交 UI、翻译和清理代码。**

```bash
git add src/pages/EditMonitor.vue src/lang/en.json src/lang/zh-CN.json \
  server/model/monitor.js test/backend-test/test-real-browser-session-state.js
git commit -m "feat: configure persistent browser session monitors"
```

### Task 4: 构建验证、手工验证和使用文档

**Files:**
- Create: `extra/persistent-browser-session.md`
- Modify: `README.md`（仅添加指向新功能文档的简短链接，若项目 README 的功能文档区域存在）
- Test: `test/e2e/real-browser-persistent-session.spec.js`（若当前 Playwright e2e 环境可启动；否则在文档中记录手工验证步骤）

**Interfaces:**
- 文档定义用途、数据保存位置、删除方式、如何选择公开可见的 Ready Selector，以及不保证外部平台保活的限制。

- [ ] **Step 1: 编写手工验证清单。**

文档必须包含：创建 Real Browser monitor；启用持久会话；设置公开页面中的 `#app-ready`；运行两次检查；确认截图均成功；检查数据目录出现 `<monitor-id>.json`；禁用该设置并确认旧文件不再更新；删除 monitor 并确认文件被删除。

- [ ] **Step 2: 为公共测试页增加 e2e 测试（仅在现有环境可运行）。**

```javascript
test("real browser monitor persists state only when explicitly enabled", async ({ page }) => {
    // 创建 monitor，启用 Persistent Browser Session，填写 #app-ready。
    // 触发两次检查，并由测试页的 localStorage 计数器断言第二次能读到第一次状态。
});
```

- [ ] **Step 3: 执行全量格式和测试。**

Run: `pnpm lint`  
Expected: PASS。

Run: `pnpm test-backend`  
Expected: PASS。

Run: `pnpm build`  
Expected: PASS。

- [ ] **Step 4: 检查工作区、提交并推送功能分支。**

```bash
git status --short
git add extra/persistent-browser-session.md README.md test/e2e/real-browser-persistent-session.spec.js
git commit -m "docs: document persistent browser sessions"
git push -u origin feat/persistent-browser-session
```

## Self-Review

本计划覆盖了可选持久会话、就绪校验、数据隔离、原子 state 写入、删除清理、UI、翻译、单元测试、构建验证和使用文档。没有实现登录、Token/Cookie 导入、指纹伪造或任何平台资源调度绕过。接口命名在各任务中保持 `browserPersistSession` / `browserReadySelector`（前端与 JSON）和 `browser_persist_session` / `browser_ready_selector`（数据库）一致。
