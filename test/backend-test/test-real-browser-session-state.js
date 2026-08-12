const { beforeEach, afterEach, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const Database = require("../../server/database");
const {
    getBrowserSessionStatePath,
    loadBrowserSessionState,
    saveBrowserSessionState,
    removeBrowserSessionState,
} = require("../../server/monitor-types/real-browser-session-state");
const { assertRealBrowserReady } = require("../../server/monitor-types/real-browser-monitor-type");

let dataDir;

beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uptime-kuma-browser-session-"));
    Database.dataDir = dataDir;
});

afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
});

test("browser session state path is monitor scoped", () => {
    assert.strictEqual(getBrowserSessionStatePath(42), path.join(dataDir, "browser-session-states", "42.json"));
    assert.throws(() => getBrowserSessionStatePath("../../etc/passwd"), /positive integer/);
});

test("missing browser session state returns undefined", async () => {
    assert.strictEqual(await loadBrowserSessionState(42), undefined);
});

test("saves browser session state atomically and reloads it", async () => {
    const context = {
        async storageState({ path: outputPath }) {
            await fs.writeFile(outputPath, JSON.stringify({ cookies: [], origins: [] }));
        },
    };

    await saveBrowserSessionState(context, 42);

    const statePath = getBrowserSessionStatePath(42);
    assert.strictEqual(await loadBrowserSessionState(42), statePath);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(statePath, "utf-8")), { cookies: [], origins: [] });
});

test("invalid browser session state is rejected", async () => {
    const statePath = getBrowserSessionStatePath(42);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "not-json");

    await assert.rejects(loadBrowserSessionState(42), /invalid JSON/);
});

test("removing browser session state is idempotent", async () => {
    const statePath = getBrowserSessionStatePath(42);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ cookies: [] }));

    await removeBrowserSessionState(42);
    await removeBrowserSessionState(42);
    await assert.rejects(fs.access(statePath));
});

test("ready selector waits for visibility using the supplied timeout", async () => {
    const calls = [];
    const page = {
        async waitForSelector(...args) {
            calls.push(args);
        },
    };
    const monitor = {
        getBrowserReadySelector: () => "#app-ready",
    };

    await assertRealBrowserReady(page, monitor, 12000);
    assert.deepStrictEqual(calls, [["#app-ready", { state: "visible", timeout: 12000 }]]);
});

test("missing ready selector does not wait", async () => {
    const page = {
        async waitForSelector() {
            throw new Error("waitForSelector should not be called");
        },
    };
    const monitor = {
        getBrowserReadySelector: () => null,
    };

    await assertRealBrowserReady(page, monitor, 12000);
});
