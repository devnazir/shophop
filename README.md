# shophop

**Safe multi-store Shopify for Claude Code and Claude Desktop.**

https://github.com/user-attachments/assets/6c57bb26-f5f4-43d0-9b4e-cf476627fdb7

The claude.ai Shopify connector has one active shop per account, shared by every terminal. In shophop every tool names its store, so you can work with several stores at once without switching.

- **No custom app.** You sign in with the Shopify CLI (`shopify store auth`) using your staff account.
- **Read-only by default.** Edits, deletes and copies into production each need your OK in the Shop Manager.
- **Everything is logged.** Every change Claude tries goes to a local audit log.
- **Large data stays out of the chat.** Big results and bulk exports are saved to files.

Curious how it works? See **[How it works](HOW-IT-WORKS.md)**.

## Install

You need Node 20+ and the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) 4.9+ (`npm install -g @shopify/cli`). Works on macOS, Windows and Linux.

**1. The terminal command**

```sh
npm install -g https://github.com/devnazir/shophop/archive/refs/heads/main.tar.gz
```

Run it again to update. Uninstall with `npm uninstall -g shophop`.

**2. Add it to Claude.** Pick one per app.

| App | How |
|---|---|
| Claude Code (plugin) | `claude plugin marketplace add devnazir/shophop`<br>`claude plugin install shophop@shophop` |
| Claude Code (plain MCP server) | `claude mcp add --scope user shophop -- shophop`<br>Windows: `claude mcp add --scope user shophop -- cmd /c shophop` |
| Claude Desktop (extension) | Download `shophop.mcpb` from [Releases](https://github.com/devnazir/shophop/releases) and double-click it |
| Claude Desktop (config) | `shophop setup desktop` |

For Claude Desktop, quit it completely (Cmd+Q on macOS, or **Quit** from the tray icon on Windows) and reopen it.

**3. Protect the settings (Claude Code)**

```sh
shophop setup protect
```

This adds rules to `~/.claude/settings.json` so Claude can't change shophop's settings, approve its own copies or read your Shopify tokens. Your other settings are kept and the file is backed up. Restart Claude Code afterwards. Undo it with `--remove`.

**4. Add your stores.** Run `shophop ui`, or ask Claude to "open the shop manager". Then try "list my Shopify stores".

shophop runs on your computer, so claude.ai on the web and mobile can't use it.

## The Shop Manager

A local page where you add stores and decide what Claude may do on each:

- **Short name**: what you call the store when talking to Claude.
- **Environment**: *Development* or *Production*. Production stores get a red badge, and copies into them need your approval.
- **What Claude can do**: *Read only* (default), *Read & edit*, or *Read, edit & delete*.
- **Data Claude can use**: Products, Customers, Orders and so on. These become the Shopify scopes you approve when signing in.

It also shows pending **approvals** and an **activity** log of every change. **Remove** hides a store from shophop.

## What you can ask

- "How many products are in dev and prod?"
- "Create a metafield definition on staging"
- "Export all customers from prod"
- "Copy the B2B companies from dev to prod"

| Tool | What it does |
|---|---|
| `list_shops` | Your stores and what Claude may do on each |
| `shop_query` | Reads data from a store |
| `shop_schema` | Looks up the store's API, so Claude doesn't guess field names |
| `shop_mutation` | Changes data, if the store allows it |
| `shop_bulk_export` / `shop_bulk_status` | Exports large data to a file |
| `shop_copy_companies` | Copies B2B companies between stores |
| `shop_audit` | Reads the audit log |
| `open_shop_manager` | Opens the Shop Manager |

### Copying B2B companies

Copies companies with their locations, contacts, main contact and roles. It always starts with a dry run that shows the plan and writes nothing. Companies that already exist in the target are skipped, not merged. If it stops halfway, running it again picks up where it left off, without duplicates.

```sh
shophop copy-companies dev prod              # dry run
shophop copy-companies dev prod --apply --file shopify-data/dev/companies-123.jsonl
```

Not copied: catalogs, price lists, staff assignments, metafields, orders, store credit.

## Safety

| Gate | What it stops |
|---|---|
| Read only (default) | Every change |
| Delete access | Deletes, cancellations, refunds, archiving, merges and bulk changes |
| Production approval | Copies into a production store, until you type the domain to approve |
| Scopes | Anything outside what you granted at sign-in |
| Claude's permission prompt | Each `shop_mutation` call. Don't choose "always allow" |

Production approval covers copies only. Keep production stores on *Read only*, and switch to *Read & edit* only while you need it.

## Terminal commands

```sh
shophop ui                          # Shop Manager
shophop list                        # your stores
shophop audit [-n 20]               # recent changes
shophop setup desktop [--remove]    # add to Claude Desktop
shophop setup protect [--remove]    # Claude Code safety rules
shophop copy-companies <from> <to> [--apply] [--file f]
```

## Settings

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SHOPHOP_API_VERSION` | latest stable | Pin the Admin API version, e.g. `2026-10` (about 0.5 s faster per call) |
| `SHOPHOP_DATA_DIR` | `./shopify-data` (Claude Desktop: `~/shophop-data`) | Where exports go |
| `SHOPHOP_CONFIG` | `~/.config/shophop/shops.json` | Store settings |
| `SHOPIFY_BIN` | `shopify` | Path to the Shopify CLI |

More settings, file locations and details are in [How it works](HOW-IT-WORKS.md).

## Development

```sh
git clone https://github.com/devnazir/shophop.git && cd shophop
npm install
npm link        # `shophop` now runs this folder
npm test        # uses a fake Shopify CLI, never contacts Shopify
npm run build   # rebuild dist/ after changing src/
npm run pack:desktop   # build release/shophop.mcpb
```

## License

[MIT](LICENSE)
