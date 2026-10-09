/**
 * Patch Discord Stable to load a local Vencord source build.
 * Mirrors Vencord Installer's WriteAppAsar / patchAppAsar for Windows.
 *
 * Usage: node patch-discord.mjs <VENCORD_DIR> [--quiet]
 */
import fs from "fs";
import path from "path";

const quiet = process.argv.includes("--quiet");
const log = (...args) => {
    if (!quiet) console.log(...args);
};

const PackageJson = `{
  "name": "discord",
  "main": "index.js"
}`;

function writeAppAsar(outFile, patcherPath) {
    const files = {};
    let fileContents = "";

    const indexJsContents = `require(${JSON.stringify(patcherPath)})`;
    const indexJsBytes = Buffer.byteLength(indexJsContents, "utf8");
    fileContents += indexJsContents;
    files["index.js"] = { size: indexJsBytes, offset: "0" };

    fileContents += PackageJson;
    files["package.json"] = {
        size: Buffer.byteLength(PackageJson, "utf8"),
        offset: String(indexJsBytes)
    };

    let headerString = JSON.stringify({ files });
    const headerStringSize = Buffer.byteLength(headerString, "utf8");
    const dataSize = 4;
    const alignedSize = (headerStringSize + dataSize - 1) & ~(dataSize - 1);
    const headerSize = alignedSize + 8;
    const headerObjectSize = alignedSize + dataSize;
    const diff = alignedSize - headerStringSize;
    if (diff > 0) headerString += "0".repeat(diff);

    const headerBuf = Buffer.alloc(16);
    headerBuf.writeInt32LE(dataSize, 0);
    headerBuf.writeInt32LE(headerSize, 4);
    headerBuf.writeInt32LE(headerObjectSize, 8);
    headerBuf.writeInt32LE(headerStringSize, 12);

    fs.writeFileSync(outFile, Buffer.concat([
        headerBuf,
        Buffer.from(headerString, "utf8"),
        Buffer.from(fileContents, "utf8")
    ]));
}

function findDiscordResources() {
    const discordRoot = path.join(process.env.LOCALAPPDATA || "", "Discord");
    if (!discordRoot || !fs.existsSync(discordRoot)) {
        throw new Error(`Discord not found at ${discordRoot}`);
    }

    const appDirs = fs.readdirSync(discordRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith("app-"))
        .map(d => d.name)
        .sort()
        .reverse();

    for (const name of appDirs) {
        const resources = path.join(discordRoot, name, "resources");
        const appAsar = path.join(resources, "app.asar");
        const backup = path.join(resources, "_app.asar");
        if (fs.existsSync(appAsar) || fs.existsSync(backup)) {
            return resources;
        }
    }

    throw new Error(`No Discord app-*/resources with app.asar under ${discordRoot}`);
}

function main() {
    const venDir = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
    if (!venDir) {
        console.error("Usage: node patch-discord.mjs <VENCORD_DIR> [--quiet]");
        process.exit(1);
    }

    const patcherPath = path.join(venDir, "dist", "patcher.js");
    if (!fs.existsSync(patcherPath)) {
        console.error(`[!] Missing ${patcherPath}`);
        console.error("    Run pnpm build in the Vencord folder first.");
        process.exit(1);
    }

    const distPkg = path.join(venDir, "dist", "package.json");
    if (!fs.existsSync(distPkg)) {
        fs.writeFileSync(distPkg, "{}\n", "utf8");
        log(`    Created ${distPkg}`);
    }

    const resources = findDiscordResources();
    const appAsar = path.join(resources, "app.asar");
    const backup = path.join(resources, "_app.asar");

    if (!fs.existsSync(backup)) {
        if (!fs.existsSync(appAsar)) {
            console.error(`[!] Neither app.asar nor _app.asar found in ${resources}`);
            process.exit(1);
        }
        log(`    Backing up app.asar -> _app.asar`);
        fs.renameSync(appAsar, backup);
    } else {
        log(`    Already patched (_app.asar present); updating injector app.asar`);
        if (fs.existsSync(appAsar)) fs.unlinkSync(appAsar);
    }

    writeAppAsar(appAsar, patcherPath);
    log(`    Patched: ${resources}`);
    log(`    Loader requires: ${patcherPath}`);
}

try {
    main();
} catch (err) {
    console.error(`[!] ${err.message || err}`);
    process.exit(1);
}
