# shophop

**Safe multi-store Shopify for Claude Code.**

https://github.com/user-attachments/assets/6c57bb26-f5f4-43d0-9b4e-cf476627fdb7

Work with several Shopify stores at the same time from Claude Code.

Curious what happens under the hood? See **[How it works](HOW-IT-WORKS.md)**.

The claude.ai Shopify connector has one active shop per account, shared by every terminal. In shophop every tool takes an explicit `shop`, so different terminals, tasks and even a single conversation can each use different stores without switching.

- **No custom app.** Sign-in uses `shopify store auth` from the Shopify CLI: a browser login with your staff account, one token per store.
- **Read-only by default.** Writes, deletes and copies into production each need a separate switch or approval that only you can give, in the Shop Manager.
- **Everything is logged.** Every mutation attempt goes to an audit log you can read in the browser, the terminal or through Claude.
- **Large data stays out of the chat.** Big results and bulk exports are written to files.

## Install

Requires Node 20+ and the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) 4.9 or later (`npm install -g @shopify/cli`, check with `shopify version`).

**Platforms:**

| | Claude Code | Claude Desktop |
|---|---|---|
| **macOS** | ✅ | ✅ |
| **Windows** | ✅ | ✅ |
| **Linux** | ✅ | (no Claude Desktop for Linux) |

**As a Claude Code plugin** (MCP server, `/mcp__plugin_shophop_shophop__shops` slash command and a skill):

```sh
claude plugin marketplace add devnazir/shophop
claude plugin install shophop@shophop
```

**Or as a plain MCP server**, using the terminal command below:

```sh
claude mcp add --scope user shophop -- shophop
```

On Windows, use `claude mcp add --scope user shophop -- cmd /c shophop` instead (npm installs the command as `shophop.cmd`).

Use one or the other, not both, or Claude Code will load the server twice.

**Terminal command** (`shophop ui`, `shophop list`, … on macOS, Windows and Linux):

```sh
npm install -g https://github.com/devnazir/shophop/archive/refs/heads/main.tar.gz
```

Run the same command again to update. To pin a release instead, use its tag, e.g. `…/archive/refs/tags/v0.5.1.tar.gz`. Uninstall with `npm uninstall -g shophop`.

### Claude Desktop (macOS and Windows)

Claude Desktop runs shophop on your computer, so it uses the same Shopify sign-ins, settings and Shop Manager as Claude Code. You need the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) 4.9 or later installed. shophop finds it by itself, even though apps opened outside a terminal don't see your terminal's PATH.

Pick **one** of these two ways. Using both makes Claude Desktop load shophop twice.

**Option 1: install the extension (easiest)**

1. Download `shophop.mcpb` from the repo's [Releases](https://github.com/devnazir/shophop/releases).
2. Double-click it, or drag it into Claude Desktop → **Settings → Extensions**, and click **Install**.
3. All settings are optional, so you can leave them empty. **Export folder** defaults to `~/shophop-data`. Fill in **Shopify CLI path** only if shophop says it can't find the Shopify CLI; then paste the output of `which shopify` (macOS) or `where shopify` (Windows).

Claude Desktop runs the extension with its own built-in Node, so there are no paths to set up.

**Option 2: use the terminal command**

After installing the [terminal command](#install):

```sh
shophop setup desktop
```

This adds shophop to Claude Desktop's config with the right paths, keeping your other settings, and saves a backup next to it the first time. Options: `--data-dir DIR` for where exports go (default `~/shophop-data`), and `--remove` to take it out again.

**Then, either way:**

1. Quit Claude Desktop completely and reopen it. Closing the window isn't enough: on macOS press **Cmd+Q**; on Windows right-click the Claude icon in the system tray and choose **Quit**.
2. Check that **Settings → Developer** (or **Extensions**) shows shophop as running.
3. Add your stores: ask Claude to "open the shop manager", or run `shophop ui`.
4. Try it: "List my Shopify stores".

If it doesn't start, check the log: `~/Library/Logs/Claude/mcp-server-shophop.log` on macOS, `%APPDATA%\Claude\logs\mcp-server-shophop.log` on Windows.

**claude.ai on the web and mobile** can't use shophop. They only connect to servers reachable over the internet, and shophop runs locally on your computer with your Shopify sign-ins.

## Add stores: the Shop Manager

Open it with any of:
- `shophop ui` in a terminal
- the slash command in Claude Code: `/mcp__plugin_shophop_shophop__shops` if you installed the plugin, `/mcp__shophop__shops` if you added the plain MCP server
- asking Claude to "open the shop manager"

It's a local page (127.0.0.1 only, with a random token in the URL). Each store is a card showing its environment, what Claude may do, and who's signed in. **+ Add store** or a card's **Settings** opens a side panel with:

- **Store domain and short name.** The short name is what you call the store when talking to Claude.
- **Environment.** *Development / staging* or *Production*. Production stores get a red badge, a `PRODUCTION` banner on Claude's replies, and copies into them need your approval.
- **What Claude can do.** *Read only* (default), *Read & edit* (creates and updates; deletes still blocked), or *Read, edit & delete*. Giving more access asks for confirmation, and on a production store you type the domain.
- **Data Claude can use.** Areas like Products, Customers and Orders, each with a Read and an Edit tick. These become the Shopify scopes; **Advanced** shows the exact list and takes extra scopes.

The button says **Sign in with Shopify** when the data access changed (Shopify asks you to approve in the browser, with progress shown as steps) and **Save** when only settings changed.

Also on the page:
- **Approvals.** Copies into a production store wait at the top until you type the store's domain.
- **Activity.** Every change, filterable by store and result, with who made it: Claude, the Shop Manager or the terminal.
- **Remove.** The store disappears from shophop and Claude can't use it. The Shopify CLI can't sign out of a store, so it's hidden rather than signed out; restore it from the page or by signing in again.

Settings are saved to `~/.config/shophop/shops.json`. You never need to edit it.

## Tools Claude gets

| Tool | What it does |
|---|---|
| `list_shops` | Stores, short names, scopes, staff user, writable / destructive / production flags, Shopify CLI version check |
| `shop_query` | Read-only Admin GraphQL query on one store. Large results go to a file |
| `shop_schema` | Looks up the store's real API schema, so Claude doesn't guess field names |
| `shop_mutation` | A mutation on one store. Refused on read-only stores, and deletes are refused unless destructive changes are allowed |
| `shop_bulk_export` | Starts a bulk query and waits up to 20 s. Small exports come back as a file; large ones return an operation ID |
| `shop_bulk_status` | Checks a bulk export and downloads it when done. Keeps no state, so it survives restarts |
| `shop_copy_companies` | Copies B2B companies between stores: dry run first, then apply in batches |
| `shop_audit` | Reads the audit log |
| `open_shop_manager` | Opens the Shop Manager |

The server also tells Claude how to work: find the store with `list_shops`, look up the schema, read before writing, say what will change before writing, and check `userErrors`.

## Copy B2B companies between stores

This copies Shopify **B2B companies** only, with their locations, contacts (customers), main contact and roles. Ordinary customers, products, orders and other data are not part of it.

Ask Claude, e.g. "copy the companies from dev to prod", or use the terminal:

```sh
shophop copy-companies dev prod              # export + dry run, writes nothing
shophop copy-companies dev prod --apply --file shopify-data/dev/companies-123.jsonl
```

1. **Export.** The source store's companies are exported with a bulk query.
2. **Dry run.** It reads the target and shows the plan: companies to create, companies skipped because the same name or externalId already exists (never merged), contacts that reuse an existing customer by email, and payment terms that couldn't be matched.
3. **Approval, if the target is production.** The dry run files a request, and you approve it in the Shop Manager by typing the target domain. The approval covers that export and store pair for 24 hours.
4. **Apply.** Creates each company with its locations (addresses, tax settings, checkout settings, payment terms), contacts, main contact and contact roles. Claude works in batches of 10; the terminal command does them all.

Progress is saved to `shopify-data/<target>/idmap-companies-from-<source>.json` after every step. Re-running resumes where it stopped and never creates duplicates.

**Not copied:** catalogs and price lists, staff assignments, metafields, orders, store credit, deposits.

## Safety

| Gate | What it stops | Who can open it |
|---|---|---|
| Read only (default) | Every mutation | You, in the Shop Manager (**What Claude can do** → *Read & edit*) |
| Delete access | Deletes and removals, cancellations, refunds and captures, closing orders, deactivating, unpublishing, archiving, merging, bulk mutations, and anything shophop can't fully read | You, in the Shop Manager (*Read, edit & delete*) |
| Production approval | Any copy into a production store (dev → prod, prod → prod) | You, by typing the domain on the approval card |
| Scopes | Anything outside what you granted at sign-in | You, by signing in again |
| Claude Code permission prompt | Each `shop_mutation` call | You. Don't pick "always allow" for it |

**Production approval covers copies only.** If a production store is set to *Read & edit*, other changes Claude makes with `shop_mutation` go through without an approval card. They are still logged, and Claude Code still asks before each call. So keep production stores on *Read only*, and switch one to *Read & edit* only for as long as you need it.

**Stop Claude from opening these gates itself (Claude Code).** Claude Code has file and shell tools, so run this once:

```sh
shophop setup protect
```

It adds rules to `~/.claude/settings.json` that stop Claude from changing your shophop settings, approving its own copies, or reading your Shopify tokens. Then restart Claude Code.

- **It merges.** Your other rules and settings stay as they are, it never adds duplicates, and the file is backed up (`settings.json.bak`) the first time.
- **`permissions.deny`** blocks Claude's file tools (Read, Edit, Write) for shophop's settings folder and the Shopify CLI's token file, in every mode.
- **`autoMode.hard_deny`** covers what file rules can't, such as shell commands (`mv`, `sed`, `curl` …) and the Shop Manager's local API. It applies in auto mode; in the default mode, Claude Code already asks before every shell command.
- It uses the right token-file location on macOS, Linux and Windows. Undo it with `shophop setup protect --remove`.

<details>
<summary>Prefer to add the rules by hand?</summary>

Merge this into `~/.claude/settings.json` (macOS paths shown; `shophop setup protect` fills in the right ones on Windows and Linux). If the file already has `permissions.deny` or `autoMode.hard_deny`, add these entries to the existing lists, and keep `"$defaults"` first in `hard_deny` so Claude Code's built-in rules still apply.

```json
{
  "permissions": {
    "deny": [
      "Edit(~/.config/shophop/**)",
      "Read(~/Library/Preferences/shopify-cli-store-nodejs/**)",
      "Edit(~/Library/Preferences/shopify-cli-store-nodejs/**)"
    ]
  },
  "autoMode": {
    "hard_deny": [
      "$defaults",
      "Creating, modifying, moving or deleting anything under ~/.config/shophop/ (the shophop store config, audit log and production-copy approvals) by any means, including shell commands, scripts or other programs. Only the user changes these, through the Shop Manager UI.",
      "Calling the shophop Shop Manager's local HTTP API (127.0.0.1 /api/approvals, /api/shops, /api/auth) with curl, fetch, a browser automation tool or any other client, e.g. to approve a copy into a production store or change a store's writable, destructive or production settings. Only the user does this, by hand in their own browser."
    ]
  }
}
```

</details>

**Claude Desktop** has no shell or file tools of its own, so these rules aren't needed there, and every shophop tool call asks you first. If you've installed another extension that can edit files or run commands, don't give it access to `~/.config/shophop/`.

**Audit log:** `~/.config/shophop/audit.log`.
- JSONL, in your user folder (on macOS and Linux, readable only by your user).
- Each entry has the store, staff user, who sent it, the mutation fields, the outcome (`sent`, `userErrors`, `failed`, `refused`), the mutation text and variables, and a shortened result.
- A new file starts each month (`audit-YYYY-MM.log`) and the last 12 are kept.
- Variables can contain customer data. The log never leaves your machine.

**Tokens** are stored by the Shopify CLI, in a plain file rather than the system keychain: `~/Library/Preferences/shopify-cli-store-nodejs/config.json` on macOS, `%APPDATA%\shopify-cli-store-nodejs\Config\config.json` on Windows, `~/.config/shopify-cli-store-nodejs/config.json` on Linux. It sits in your user's own folders. They are online tokens tied to your staff account, which the CLI refreshes itself. The server can do only what your staff account can do in each store.

## Terminal commands

```sh
shophop ui [--no-open] [--port N]   # Shop Manager
shophop list                        # stores and flags
shophop audit [-n 20]               # recent mutations
shophop setup desktop [--data-dir DIR] [--remove]   # add to Claude Desktop
shophop setup protect [--remove]                    # add Claude Code safety rules
shophop copy-companies <from> <to> [--file f] [--only "A,B"] [--apply] [--batch 10]
```

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `SHOPHOP_API_VERSION` | latest stable | Pin the Admin API version, e.g. `2026-10`. Saves about 0.5 s per call |
| `SHOPHOP_DATA_DIR` | `./shopify-data` in the Claude Code project; `~/shophop-data` for Claude Desktop | Where exports, plans and ID maps go |
| `SHOPHOP_INLINE_LIMIT` | `15000` | Results longer than this (characters) are written to a file instead |
| `SHOPHOP_CONFIG` | `~/.config/shophop/shops.json` | Config file |
| `SHOPHOP_AUDIT` | next to the config | Audit log |
| `SHOPHOP_AUDIT_KEEP_MONTHS` | `12` | Monthly audit archives to keep |
| `SHOPHOP_APPROVALS` | next to the config | Production-copy approvals |
| `SHOPHOP_UI_PORT` | any free port | Port for the Shop Manager |
| `SHOPIFY_BIN` | `shopify` | Path to the Shopify CLI |

## Speed

Each call starts the Shopify CLI, which takes about 2 s on its own. A repeat `shop_query` takes about 3 s, because the list of signed-in stores is cached for 30 s. Pinning `SHOPHOP_API_VERSION` takes another ~0.5 s off.

## Development

```sh
git clone https://github.com/devnazir/shophop.git && cd shophop
npm install
npm link        # your `shophop` command now runs this checkout
npm test        # tests against a stand-in Shopify CLI; never contacts Shopify (CI runs them on macOS, Windows and Linux)
npm run build   # bundles dist/shophop.js for the plugin (rebuild after changing src/)
npm run pack:desktop   # builds release/shophop.mcpb, the Claude Desktop extension (upload it to a GitHub release)
npm run bench -- <shop>   # times a read-only query on a real store
claude plugin validate .
```

Tested against Shopify CLI 4.9.x. `list_shops` warns when the installed version is different.

## License

[MIT](LICENSE)
