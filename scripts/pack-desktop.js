// Build the Claude Desktop extension: release/shophop.mcpb
// The extension is the bundled server (dist/) + the Shop Manager page + manifest and icon (extension/).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const stage = join(root, "release", "extension");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(join(root, "release"), { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

// Keep the extension's version in step with package.json.
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(join(root, "extension", "icon.png"), join(stage, "icon.png"));
copyFileSync(join(root, "dist", "shophop.js"), join(stage, "server", "shophop.js"));
copyFileSync(join(root, "dist", "page.html"), join(stage, "server", "page.html"));

const out = join(root, "release", "shophop.mcpb");
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", stage, out], { stdio: "inherit" });
console.log(`\nBuilt ${out}`);
