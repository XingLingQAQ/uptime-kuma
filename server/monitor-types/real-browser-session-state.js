const fs = require("fs/promises");
const path = require("path");
const Database = require("../database");

/**
 * Validate a monitor identifier before using it in a filesystem path.
 * @param {number|string} monitorID Monitor ID
 * @returns {number} Normalized monitor ID
 * @throws {Error} If the monitor ID is not a positive safe integer
 */
function normalizeMonitorID(monitorID) {
    const normalizedID = Number(monitorID);

    if (!Number.isSafeInteger(normalizedID) || normalizedID <= 0) {
        throw new Error("Browser session state requires a positive integer monitor ID");
    }

    return normalizedID;
}

/**
 * Get the directory used for isolated real-browser session state files.
 * @returns {string} Session state directory
 */
function getBrowserSessionStateDirectory() {
    return path.join(Database.dataDir, "browser-session-states");
}

/**
 * Get the storage state path for a monitor.
 * @param {number|string} monitorID Monitor ID
 * @returns {string} Session state file path
 */
function getBrowserSessionStatePath(monitorID) {
    return path.join(getBrowserSessionStateDirectory(), `${normalizeMonitorID(monitorID)}.json`);
}

/**
 * Load a validated Playwright storage state file path when it exists.
 * @param {number|string} monitorID Monitor ID
 * @returns {Promise<string|undefined>} State path or undefined when no state has been saved
 */
async function loadBrowserSessionState(monitorID) {
    const statePath = getBrowserSessionStatePath(monitorID);

    try {
        const content = await fs.readFile(statePath, "utf-8");
        JSON.parse(content);
        return statePath;
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }

        if (error instanceof SyntaxError) {
            throw new Error(`Browser session state for monitor ${monitorID} is invalid JSON`);
        }

        throw error;
    }
}

/**
 * Persist a Playwright BrowserContext storage state using an atomic rename.
 * @param {import("playwright-core").BrowserContext} context Browser context
 * @param {number|string} monitorID Monitor ID
 * @returns {Promise<void>}
 */
async function saveBrowserSessionState(context, monitorID) {
    const stateDirectory = getBrowserSessionStateDirectory();
    const statePath = getBrowserSessionStatePath(monitorID);
    const tempPath = path.join(stateDirectory, `.${normalizeMonitorID(monitorID)}.${process.pid}.tmp`);

    await fs.mkdir(stateDirectory, { recursive: true });

    try {
        await context.storageState({ path: tempPath });
        await fs.rename(tempPath, statePath);
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

/**
 * Remove a monitor's persisted browser session state.
 * @param {number|string} monitorID Monitor ID
 * @returns {Promise<void>}
 */
async function removeBrowserSessionState(monitorID) {
    await fs.rm(getBrowserSessionStatePath(monitorID), { force: true });
}

module.exports = {
    getBrowserSessionStateDirectory,
    getBrowserSessionStatePath,
    loadBrowserSessionState,
    saveBrowserSessionState,
    removeBrowserSessionState,
};
