# Persistent Browser Session for Real Browser Monitors

## Purpose

Real Browser monitors can optionally preserve a monitor-scoped Playwright storage state between successful checks. This lets the monitor retain **public-site** cookies and local storage that are created through ordinary page navigation, while still creating a new browser context for each check.

This feature improves browser-monitor continuity and page-readiness validation. It does **not** import account credentials, perform automatic logins, bypass access controls, or guarantee that a third-party hosting provider will classify an automated visit as activity.

## Enable the feature

Create or edit a monitor whose type is **Real Browser**. In the Advanced section, enable **Persistent Browser Session**. Optionally enter a **Ready Selector**, such as `#app-ready`, for an element that becomes visible only after the public application is ready.

A check is marked up only after the following conditions are satisfied:

| Condition      | Requirement                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Navigation     | The configured HTTP(S) URL finishes loading with `networkidle`.                      |
| Response       | The navigation response is in the 200–399 range.                                     |
| Ready Selector | When configured, the public CSS selector becomes visible before the monitor timeout. |
| Screenshot     | The normal Real Browser screenshot is written successfully.                          |

After a successful check, the monitor's storage state is saved for the next check. Failed checks never overwrite the previously saved state.

## State storage and deletion

State files are stored below the Uptime Kuma data directory in:

```text
browser-session-states/<monitor-id>.json
```

Each monitor receives an isolated file. Deleting the monitor attempts to remove that file. Operators can also delete a specific state file while Uptime Kuma is stopped to reset the monitor's browser session.

The state may include cookies and local storage created by the public site. Treat the Uptime Kuma data directory as sensitive operational data and do not manually add cookies, access tokens, credentials, or browser fingerprints to these files.

## Recommended validation

Use the feature first as a diagnostic experiment. Run an unmodified Real Browser monitor and a persistent-session monitor against the same public application for a complete service lifecycle. Compare the Uptime Kuma heartbeat, application logs and the hosting provider's runtime status. If the provider still suspends the application, treat the result as a hosting lifecycle decision rather than a browser-monitor defect.
