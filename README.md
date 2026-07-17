# OpenCode Session Token Summary

An OpenCode TUI plugin that adds a compact session-usage panel to the sidebar.
It aggregates the root session and all nested subagent sessions.

![alt text](image.png)

## Features

- Compact OpenCode sidebar panel with live session updates
- Input, output, reasoning, cache read, cache write, and total token counts
- Cache hit ratio and assistant turn count
- Usage aggregated across the root session and every nested subagent
- Reported API costs for metered providers
- API-equivalent cost estimates for quota and subscription-backed providers
- One combined cost total for sessions that mix metered and quota-backed models
- Clear labels distinguishing reported, estimated, and partially estimated costs
- Models.dev-backed pricing with model alias matching and context-tier support
- Bounded concurrent requests for nested subagent discovery
- Race-safe refreshes that retain the last complete snapshot after API failures

## Requirements

- OpenCode `>=1.17.9`

## Install

Install this plugin through OpenCode's plugin installation flow:

1. Press `Ctrl+P` in OpenCode and choose **Install plugin**.
2. Press `Tab` to install globally.
3. Enter `opencode-plugin-session-token-summary` without a version or
   `@latest` suffix.

The installation creates an entry referencing this package in
`~/.config/opencode/tui.json`.

This plugin is functional only in version `0.3.0` and later.

### Updating

OpenCode does not currently support plugin updates reliably. See OpenCode PRs
[#35777](https://github.com/anomalyco/opencode/pull/35777),
[#32822](https://github.com/anomalyco/opencode/pull/32822), and
[#37300](https://github.com/anomalyco/opencode/pull/37300). To force OpenCode
to download current plugin versions, clear its plugin cache:

```sh
rm -rf ~/.cache/opencode
```

## Notes

The panel obtains descendant aggregates from OpenCode's session API and fetches
descendant messages to count their assistant turns. Requests are limited to four
concurrent operations. A failed refresh leaves the last complete sidebar values
in place rather than showing partial totals.

Nonzero cost reported by OpenCode is shown as `$ cost`. For messages with an
explicit zero cost, the plugin uses OpenCode's Models.dev-backed provider
catalog to calculate what the same tokens would cost at published API rates.
Fully estimated totals are shown as `$ est. cost`; totals that combine reported
and estimated amounts are shown as `$ cost incl. est.` Quota or subscription
users are not necessarily charged the estimated amount. If catalog pricing
cannot be matched, only the reported cost is shown.

## Development

```sh
npm install
npm run check
npm run pack:check
```

## License

[MIT](LICENSE)
