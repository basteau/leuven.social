# Vendored agent skills

Copied verbatim from their upstream repositories, reviewed before adding, and kept unformatted (see `.prettierignore`). `.claude/skills` is a symlink to this folder so Claude Code finds them too.

| Skill | Source | Commit | License | Use it for |
| --- | --- | --- | --- | --- |
| `better-interface` + `better-accessibility`, `better-layout`, `better-writing`, `better-typography`, `better-colors`, `better-ui` | [jakubkrehel/skills](https://github.com/jakubkrehel/skills) | `592aedc44d7d` (2026-10-25) | MIT | Reviewing or building any HUD screen. `better-interface` runs the six others and needs all of them. |
| `mobile-native` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `a81dbca07f22` (2026-10-28) | MIT | Anything touch, viewport, safe-area or PWA related. |
| `good-css` | [vojtaholik/good-css](https://github.com/vojtaholik/good-css) ([good-css.com](https://good-css.com)) | `92d436ba1937` (2026-10-10) | MIT | Every CSS change. |
| `agent-browser` | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | `5868f7c05020` (2026-10-31) | Apache-2.0 | Driving the app in a real browser. It's a discovery stub: `bunx agent-browser skills get core` prints the guide matching the installed CLI. |

To update one, re-copy its folder from upstream at a newer commit, read the diff, and update the commit column.
