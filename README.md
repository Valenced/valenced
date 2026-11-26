<p align="center">
    <img
        width="128px"
        src="assets/logo.svg"
    >
    <h1 align="center">Valenced</h1>
    <p align="center"><strong>Supercharge your Discord experience.</strong> A client modification for Discord mobile.</p>
    <br>
    <div align="center">
        <a href="https://discord.com/invite/dtBTQHYSx4">
            <picture>
                <source height="32px" media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/13122796/178032563-d4e084b7-244e-4358-af50-26bde6dd4996.png" />
                <img height="32px" src="https://user-images.githubusercontent.com/13122796/178032563-d4e084b7-244e-4358-af50-26bde6dd4996.png" />
            </picture>
        </a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <a href="https://github.com/Valenced">
            <picture>
                <source height="32px" media="(prefers-color-scheme: dark)" srcset="https://i.ibb.co/dMMmCrW/Git-Hub-Mark.png" />
                <img height="32px" src="https://i.ibb.co/9wV3HGF/Git-Hub-Mark-Light.png" />
            </picture>
        </a>
    </div>
</p>

## ❓ About

Valenced is a client modification for Discord mobile. This repository is a monorepo that builds Valenced.

## ✨ Features

- **🔌 Plugins**: Extend Discord with custom features
- **🎨 Themes, fonts, icons & emojis**: Customize Discord's appearance to your liking
- **🧪 Experiments**: Try out Discord's new features before they're rolled out

## ⬇️ Download

Get Valenced for Android at [valenced.app](https://valenced.app).

## 👷 Codebase

Valenced uses TypeScript and Kotlin Multiplatform to share code between platforms. The codebase is split into four modules:

- **[bundle](bundle)**: Hermes bytecode that runs inside official Discord clients. It requires the loaders to run, and is built into them in each release.
- **[core](core)**: Shared Kotlin Multiplatform codebase for the loaders, containing the plugin system, and other shared code.
- **[android](android)**: Android loader and native plugin API, which is an Xposed module loading the Valenced bundle into Discord.
  - **[android/patches](android/patches)**: [Reseam](https://reseam.app) patches Valenced Manager applies to Discord to load the Xposed module.
- **[ios](ios)**: iOS loader, which is a tweak loading the Valenced bundle into Discord.

## 📄 License

This project is licensed under the GPL-3.0 License. See [LICENSE](LICENSE) for details.

[android/patches](android/patches) is licensed under the AGPL-3.0, see [its license](android/patches/LICENSE) and [notice](android/patches/NOTICE).
