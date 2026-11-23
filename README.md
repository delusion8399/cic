# cic: Chrome in CLI

Drive your real Chrome from the terminal: open tabs, click, type, read the page, run JavaScript,
watch network and console, take screenshots. Built for AI coding agents that work through a shell,
and handy for scripted UI checks.

```
cic <command> ──HTTP──► cic daemon (127.0.0.1:18765) ◄──long-poll── cic extension
                                                                       │
                                                                       └─ chrome.debugger (CDP)
```

- **Your browser, your session.** It runs inside the Chrome you already use, so you're signed in
  wherever you are signed in. No separate browser, no remote debugging port.
- **Bounded.** cic only drives tabs it opened itself, which it keeps in a purple **cic** tab group.
  Commands on any other tab are refused.
- **Local only.** The daemon listens on 127.0.0.1. Nothing leaves your machine.
- **No dependencies.** One Node file plus an unpacked MV3 extension.

## Install

```sh
git clone <this repo> cic && cd cic
./install.sh                     # links bin/cic into ~/.local/bin (BIN_DIR=... to change)
```

Then load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `cic/extension`.

```sh
cic status      # {"daemon":true,"extension":true,"extension":"0.2.0"}
```

The daemon starts on the first command; `cic stop` stops it. State lives in `~/.cic`.

## Commands

Targets are a CSS selector or a ref from `snapshot` (`@e12`). Points are CSS pixels, the same
pixels as a `screenshot`, so a point read off a screenshot can be clicked as is.

| Command | Does |
|---|---|
| `cic tabs` | Tabs in the cic group |
| `cic open <url>` | New tab in the group; prints its id |
| `cic navigate <tab> <url\|back\|forward\|reload>` | Go somewhere |
| `cic snapshot <tab> [--all] [filter]` | Visible interactive elements with `@refs`, roles, names, state and centre points |
| `cic text <tab>` | Page text |
| `cic eval <tab> <js>` | Run JavaScript (promises awaited), print the value |
| `cic click <tab> <target\|x y> [--right] [--double] [--triple]` | Real mouse click |
| `cic hover <tab> <target\|x y>` | Move the mouse there |
| `cic drag <tab> <from> <to>` | Drag between targets or `x,y` points |
| `cic scroll <tab> [up\|down\|left\|right] [amount] [--at <target>]` | Mouse-wheel scroll |
| `cic scrollto <tab> <target>` | Scroll an element into view |
| `cic type <tab> <text>` | Type into the focused element |
| `cic key <tab> <combo...> [--repeat n]` | Keys and combos: `Enter`, `Tab`, `cmd+a`, `shift+Tab`, `F5` |
| `cic fill <tab> <target> <value>` | Set an input, textarea, select (value or label) or checkbox (`true`/`false`) |
| `cic upload <tab> <target> <file...>` | Set a file input |
| `cic wait <tab> <target\|ms>` | Wait for an element or a time |
| `cic screenshot <tab> [file.png] [--region x0,y0,x1,y1]` | PNG of the viewport, or a zoomed region |
| `cic network <tab> [filter] [--clear]` | Requests the tab made, with status |
| `cic body <tab> <filter>` | Body of the last finished request matching `filter` |
| `cic console <tab> [regex] [--clear]` | Console messages, exceptions and browser log entries |
| `cic dialog <tab> [accept\|dismiss] [text]` | Show or answer an open alert/confirm/prompt |
| `cic resize <tab> <width> <height>` | Resize the window |
| `cic close <tab>` | Close the tab |
| `cic reload-extension` | Reload the extension after you edit it |

Quote URLs with `?` or `&` in zsh: `cic open 'http://localhost:3000/x?a=1'`.

## Example

```sh
tab=$(cic open https://example.com | sed -n 's/.*"id": \([0-9]*\).*/\1/p')
cic snapshot $tab
cic click $tab @e1
cic screenshot $tab
cic close $tab
```

## License

MIT
