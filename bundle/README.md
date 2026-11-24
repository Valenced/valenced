# ❓ About

This directory contains the Valenced bundle: Hermes bytecode that runs inside official Discord clients.
The bundle is not standalone. It requires the Android and iOS loaders in this repository.

## ⬇️ Download

Install a loader from this repository's [Releases](https://github.com/Valenced/valenced/releases/latest). The bundle is already built into the loader.

## 👷 Developing

You'll need to have [Deno](https://deno.land/) installed. Once you have Deno, follow these steps:

```sh
# Install dependencies
deno install
```

---

```sh
# Build the bundle
deno run build

# Build with debugging enabled (slow, don't use in production)
deno run build --dev
```

```sh
# Start the development server
deno run dev

# Build as production
deno run dev --prod
```

<sub>Builds are generated at `dist/valenced.bundle`. URLs come from `build.env`, and `.env` overrides them locally.</sub>

Gradle builds the bundle into the loaders (`./gradlew :android:assembleDebug` from the repository root). Debug loaders ship the development build. Gradle requires the Deno version in `.dvmrc` and ignores `.env`, so its builds are reproducible.

### 🔄️ Testing with a loader

**Only debug builds** of the loaders can load the bundle from the development server instead of the one they built with.

1. Start the development server with `deno run dev --lan`.
2. In Discord, go to **Settings** > **Developer** (under the **Valenced** section) and tap **Evaluate JavaScript**.
3. Paste and evaluate the following snippet, with your computer's address:

    ```js
    var HOST = "http://<address>:4040";
    valenced.discord.native.FileModule.writeFile("documents", "valenced/loader.json", JSON.stringify({ customLoadUrl: { enabled: true, url: HOST + "/valenced.bundle", manifestUrl: HOST + "/manifest.json", phoenixUrl: HOST + "/valenced.phoenix.bundle" } }), "utf8");
    ```

4. Restart Discord. To go back to the shipped bundle, use **Reset Loader Config** in the recovery options.

### 📝 Generating types

```sh
# Build types for external consumers
deno run types
```

Types are generated at `dist/types`. To consume, simply add `@valenced/types` as a dependency and include the following in your TypeScript config:

```json
{
  "compilerOptions": {
    "types": ["@valenced/types"]
  }
}
```

Your bundler will need to map imports to property access on `valenced` by reading `@valenced/types/modules.importmap.json`, which maps every rewritable module to its access path.

```json
{
  "@valenced/discord/modules/main_tabs_v2": "valenced.discord.modules.mainTabsV2",
  "@valenced/components/Page": {
    "global": "valenced.components.Page",
    "interop": "default"
  }
}
```

An `interop` of `default` means the property contains the module's default export, not its namespace. A namespace/wildcard import of such a module must be rewritten specially.

`@valenced/types/modules.json` lists every module name the package declares, including type-only modules, which have no property on `valenced` and so never appear in the import map.

#### 🛠️ Developer Mode & Hidden API

The [hidden API](./lib/hidden) exposes internal fields and methods that are **not** part of the public API. They can break or change at any time, and are only meant for debugging.
Some experimental APIs may also be exposed through the hidden API before they are added to the public API.

You must enable **Developer Mode** in Valenced's settings in order to expose the [hidden API](./lib/hidden) to plugins that depend on [`valenced.api.hidden`](./src/plugins/preinit/api.hidden).

To consume the hidden API, add the following to your TypeScript config:

```json
{
  "compilerOptions": {
    "types": ["@valenced/types", "@valenced/types/hidden"]
  }
}
```

Hidden modules are kept out of `modules.json` and `modules.importmap.json`, and out of the public API. They live in `modules.hidden.json` and `modules.hidden.importmap.json` instead, with paths under `valenced.hidden`.
