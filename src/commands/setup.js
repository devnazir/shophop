// shophop setup desktop  — add shophop to Claude Desktop
// shophop setup protect  — add Claude Code rules that stop Claude from changing shophop's settings or reading tokens
const SUBCOMMANDS = {
  desktop: () => import("./setup-desktop.js"),
  protect: () => import("./setup-protect.js"),
};
const USAGE = "Usage: shophop setup desktop [--data-dir DIR] [--remove]\n       shophop setup protect [--remove]";

export async function run(args) {
  const load = SUBCOMMANDS[args[0]];
  if (!load) { console.log(USAGE); process.exit(2); }
  const { run: sub } = await load();
  await sub(args.slice(1));
}
