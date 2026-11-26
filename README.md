# Larkdoc-sync

English · [简体中文](./README_ZH.md)

Write in Obsidian and share a Feishu or Lark Docs link with your team. Larkdoc-sync uses the local [`lark-cli`](https://github.com/larksuite/cli) to publish a note once and update the same document when the note changes.

> **One-way sync: Obsidian → Feishu/Lark.** Changes made in the remote document do not come back to Obsidian. Bring any remote edits you want to keep into the local note before you sync again.

**Originally derived from:** [wanghuan9/obsidian-feishu-lark-cli-sync](https://github.com/wanghuan9/obsidian-feishu-lark-cli-sync). This edition is directly based on [totok22/feishu-docs-publisher](https://github.com/totok22/feishu-docs-publisher) and maintained by [jipengju-GitHub](https://github.com/jipengju-GitHub).

## Publish your first note

You need **Obsidian 1.13.0 or later on desktop**, a Feishu or Lark account, and Node.js with npm for building the plugin and installing the CLI.

1. **Install the plugin.** Run `npm ci` and `npm run build` from the source checkout. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/larkdoc-sync/`, restart Obsidian, and enable **larkdoc-sync** under Community plugins. Alternatively, use the included [`install.sh`](./install.sh) to copy a build into your vault.
2. **Connect your account.** Open **Basic settings** to install or detect `lark-cli`. If the CLI app is not yet configured, choose Feishu or Lark, follow the app setup prompts, then sign in or reauthorize. If detection fails, enter the executable's absolute path in the plugin settings.
3. **Choose where new notes go.** In **Default target**, enter a Wiki page URL, wiki node token, or folder token that your account can access. Leave it blank to publish notes to your personal library. Changing the default does not move existing documents.
4. **Publish.** Open a Markdown note, click the Lark icon at the top right of its tab, and choose **Sync to Feishu/Lark**. If you already have the remote document, use **Set Feishu/Lark link** to bind it before syncing.

## Working with the plugin

- **Work from the note.** The Lark menu in the note header has actions to sync, overwrite, set a link, and open the remote document. Use regular sync for routine edits. Overwrite rewrites remote content and can remove same-name duplicates at the destination, so check the target first.
- **Publish folders and attachments.** Use the file explorer's right-click menu to sync a folder or a standalone PDF. Folder sync preserves the hierarchy and connects published notes through their remote links. When you sync a note in Obsidian, referenced local files (such as PDFs, ZIPs, and TXT files) can become downloadable native cards at the end of the document without a separate upload. Wikilinks and standard Markdown links are supported. Image and video embeds and PDF page previews still follow their existing paths. Git `pre-push` does not upload these attachments; if only the attachment changes, sync the note manually.
- **Automate updates, not first-time publishing.** In **Sync settings**, choose sync after save, disable automatic sync, or use a Git `pre-push` hook. The default is to sync a bound note about 15 seconds after saving while Obsidian is open. To publish a PDF as a separate cloud file, sync the PDF itself or its folder; an attachment card in a note does not require this step.
- **Check what happened.** The Lark icon in the left ribbon opens the manager. **Published files** lists saved links and binding actions. **Publish log** shows recent publish, sync, and overwrite results, including failure details. The most recent 500 entries are kept locally in `publish-log.json`; unchanged skips and Git hook runs are not recorded there.

## Before you sync

| Situation | What to do |
| --- | --- |
| A PDF should be downloadable as an attachment | Use a plain PDF link in the note. `![[file.pdf#page=2]]` still creates a page preview instead of a native attachment card. |
| Drafts should stay local | Right-click the folder and choose **Choose files to ignore**. The `.feishuignore` rules apply to folder sync, save-triggered sync, and the Git hook, but not to a manual single-note sync. |
| Remote block comments or deep links must survive | Prefer regular sync. The default strategy may rewrite the document when a change cannot be applied incrementally. Use **Safe precise sync** if overwriting is not acceptable. First-time native Callout conversion can also rebuild the body. |
| Saving does not trigger sync | Check that the note is bound, save-triggered sync is enabled, Obsidian is open, and the file is not ignored. |
| A note is publishing to the wrong place | Check its saved binding. The default target only applies to new publications. |
| The sync hook blocks `git push` | Fix the reported sync error or switch to a different automatic sync mode. Git hook setup and network proxy options are under **Advanced settings**, collapsed by default. |

Use **Document settings** to adjust the title source, control whether a successful sync opens the document, or write `lark_doc_url` into note frontmatter. By default, bindings are only stored in local plugin data. See [native export details](./docs/native-export.md) for Callouts, PDF page embeds, and region crops.

## Moving from an earlier plugin

Larkdoc-sync now has its own plugin ID: `larkdoc-sync`. Back up your old plugin directory, **disable the old plugin without uninstalling it**, then install and enable Larkdoc-sync using the new directory above.

On first launch, if the new plugin has no saved settings, it imports existing settings, file bindings, sync state, and the local publish log from `feishu-docs-publisher` (or the earlier `feishu-lark-cli-sync`). It does not republish files or delete the old data. Verify your existing links under **Published files** before syncing again. If the vault uses a `pre-push` hook, avoid running `git push` during migration. Check the hook under **Advanced settings** afterward. If you return to the old plugin, first disable Larkdoc-sync and reinstall the previous plugin's hook; changes made after migration are not copied back.

## Network and privacy

The plugin calls official Feishu or Lark APIs through the local `lark-cli`. When you publish or sync, the selected content and its relevant attachments are sent to your authorized destination. Installing or updating the CLI contacts the npm package registry. Credentials stay in the CLI's local auth store, not in notes, plugin settings, or the publish log. There is no separate telemetry channel.

## Development and license

Run `npm run build` to bundle the plugin, `npm test` to run tests, and `npm run release:check` to validate release metadata. See the [changelog](./CHANGELOG.md) and [`release-notes/`](./release-notes/) for version history.

Thanks to the upstream contributors. Native Callouts, PDF crops, and research label colors include work from [HeShiLie's fork](https://github.com/HeShiLie/feishu-docs-publisher). This project is distributed under the MIT license; the original notices are preserved in [LICENSE](./LICENSE).
