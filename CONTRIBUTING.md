# Contributing

```bash
npm ci
npm run build   # styles/ -> styles.css, type check, src/main.ts -> main.js
npm test        # bundles tests/ with an Obsidian stub and runs them with node --test
npm run lint    # Obsidian's lint rules (with and without dev typings) and stylelint; any warning fails
npm run dev     # rebuilds main.js on every change
```

Node 20 or later. To try a change, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/japan-work-secretary/` of a test vault that has only this plugin, then reload Obsidian.

- Edit the CSS in `styles/`, not `styles.css`: the build writes `styles.css`, and it is committed, so commit both. CI fails if the build changes it.
- `package.json` sets `allowScripts` to skip esbuild's install script. The build uses esbuild's platform package directly, so nothing is lost, and a strict npm install does not stop on it.

CI runs lint, tests and the build on Node 20 and 22 for every push to `main` and every pull request. Pushing a version tag such as `1.7.2` runs the release workflow: it checks the tag against `manifest.json`, `package.json`, `package-lock.json` and `versions.json`, runs the same steps, attests `main.js`, `manifest.json` and `styles.css`, and creates the release with that version's [CHANGELOG.md](CHANGELOG.md) section as its notes.

## Issues

Open one at [GitHub Issues](https://github.com/Rexxall/japan-work-secretary/issues) with:

- the plugin version, your Obsidian version and your OS;
- what you did, what you expected and what happened;
- for an AI problem, the diagnostics from the copy button next to **Test** in settings. They contain no key and no shift content.

Never paste an API key, and replace real shift times, store names and wages with made-up ones.
