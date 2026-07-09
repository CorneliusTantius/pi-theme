# pi-theme

Pi extension that compresses noisy tool-call UI into short one-line summaries and removes extra assistant bubble chrome.

## Install

On any machine with Pi installed:

```sh
pi install git:github.com/CorneliusTantius/pi-theme
```

Then restart Pi. The extension loads on startup.

To verify:

```sh
pi list
```

You should see:

```txt
git:github.com/CorneliusTantius/pi-theme
```

## What it changes

- Tool calls render as compact summaries with status icons: `›` running, `✓` success, `✗` error.
- Common tools get better labels: `bash`, `read`, `write`, `edit`, browser, and parallel tool calls.
- Tool results are hidden in the TUI.
- Assistant messages lose extra fences/spacing and get a subtle separator.
- Thinking lines are padded to align with compact tool output.
