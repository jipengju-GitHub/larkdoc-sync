#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="larkdoc-sync"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VAULT_PATH="${1:-}"

if [ -z "$VAULT_PATH" ]; then
  read -r -p "请输入 Obsidian 仓库路径 / Obsidian vault path: " VAULT_PATH
fi

if [ -z "$VAULT_PATH" ]; then
  echo "Obsidian 仓库路径不能为空 / Obsidian vault path is required." >&2
  exit 1
fi

case "$VAULT_PATH" in
  "~")
    VAULT_PATH="$HOME"
    ;;
  "~/"*)
    VAULT_PATH="$HOME/${VAULT_PATH#"~/"}"
    ;;
esac

if [ ! -d "$VAULT_PATH" ]; then
  echo "Obsidian 仓库路径不存在 / Obsidian vault path does not exist: $VAULT_PATH" >&2
  exit 1
fi

PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
ASSETS=(manifest.json main.js styles.css)
for file in "${ASSETS[@]}"; do
  if [ ! -f "$REPO_DIR/$file" ]; then
    echo "缺少 $file，请先运行 npm ci && npm run build / Missing $file, run npm ci && npm run build first." >&2
    exit 1
  fi
done

mkdir -p "$PLUGIN_DIR"
for file in "${ASSETS[@]}"; do
  cp "$REPO_DIR/$file" "$PLUGIN_DIR/$file"
done

if [ -d "$VAULT_PATH/.obsidian/plugins/feishu-docs-publisher" ] || [ -d "$VAULT_PATH/.obsidian/plugins/feishu-lark-cli-sync" ]; then
  echo "请先禁用旧插件（不要卸载），再启用 Larkdoc-sync 迁移旧数据。"
  echo "Disable the old plugin without uninstalling it before enabling Larkdoc-sync to import data."
fi

echo "已安装到 / Installed to: $PLUGIN_DIR"
echo "请在 Obsidian 设置中启用 Larkdoc-sync。"
echo "Enable Larkdoc-sync in Obsidian settings."
echo "启用后在“CLI 与授权”中安装/升级 lark-cli、创建应用并登录。"
echo "Then use CLI & authorization in settings to install/upgrade lark-cli, create the app, and sign in."
