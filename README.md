# MCP Manager

Desktop app that manages Claude Code's MCP server connections (add, view scopes,
refresh, reauthorize, delete) without hand-editing `~/.claude.json`.

Made by Remco Kort as an experiment, feel free to use it.

## Requirements

- Windows 10/11, 64-bit.
- [Claude Code](https://claude.com/claude-code) CLI installed and on PATH —
  this app drives it under the hood for every change it makes.

## First run: SmartScreen warning

These builds are unsigned (or signed with an internal self-signed
certificate), so Windows SmartScreen will show an "unrecognized app" warning.
Click **More info → Run anyway** to proceed. If your machine has been set up
to trust Thinkwise's internal code-signing certificate, this warning won't
appear.
