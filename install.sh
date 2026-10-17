#!/usr/bin/env bash
# Installs the Aionic Sapling CLI and VS Code extension from a GitHub release of
# this repository. Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/aionic-labs/aionic_vs_code_developer_tools/main/install.sh | bash
#
# Options (after `bash -s --` when piped):
#   --tag <tag>        install this release instead of the latest one
#   --cli-only         install only the `sl` CLI
#   --extension-only   install only the VS Code extension
#   --force            reinstall even if this version is already installed
set -euo pipefail

# Bash parses the whole function before it runs anything, so a command that reads
# stdin cannot swallow the rest of a script piped in from curl.
main() {
  REPO=aionic-labs/aionic_vs_code_developer_tools
  tag=""
  cli=true
  extension=true
  force=false

  while [[ $# -gt 0 ]]; do
    case $1 in
      --tag) tag=$2; shift 2 ;;
      --cli-only) extension=false; shift ;;
      --extension-only) cli=false; shift ;;
      --force) force=true; shift ;;
      -h | --help) echo "options: --tag <tag> --cli-only --extension-only --force"; exit 0 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done

  fail() { echo "error: $*" >&2; exit 1; }

  [[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] ||
    fail "the release has a CLI build for macOS on Apple silicon only"
  if $cli; then
    command -v brew >/dev/null || fail "install Homebrew first: https://brew.sh"
  fi

  # The latest release skips prereleases. --tag selects any release.
  if [[ -n $tag ]]; then
    # GitHub tags of this repo can contain "+", which a URL must escape.
    api="https://api.github.com/repos/$REPO/releases/tags/${tag//+/%2B}"
  else
    api="https://api.github.com/repos/$REPO/releases/latest"
  fi
  release=$(curl -fsSL "$api") || fail "no release found at $api"
  tag=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])' <<<"$release")
  # Prints "<name> <download URL>" of the first asset whose name ends with $1.
  asset() {
    python3 -c '
  import json, sys
  for asset in json.load(sys.stdin)["assets"]:
      if asset["name"].endswith(sys.argv[1]):
          print(asset["name"], asset["browser_download_url"])
          break
  ' "$1" <<<"$release"
  }
  echo "Installing Aionic Sapling $tag"

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  if $cli; then
    read -r bottle_name bottle_url < <(asset .bottle.tar.gz) || fail "release $tag has no bottle"
    bottle="$work/$bottle_name"
    version=${bottle_name#sapling-}
    version=${version%%.arm64_*}
    installed=$(brew list --versions sapling 2>/dev/null | awk '{print $2}' || true)
    if [[ $installed == "$version" ]] && ! $force; then
      echo "sl $version is already installed"
    else
      # curl does not set the quarantine flag that a browser download sets.
      curl -fsSL -o "$bottle" "$bottle_url"
      if [[ -n $installed ]]; then
        brew unpin sapling 2>/dev/null || true
        # Without HOMEBREW_NO_AUTOREMOVE, brew also removes python and node, only to
      # install them again right after.
      HOMEBREW_NO_AUTOREMOVE=1 brew uninstall --ignore-dependencies sapling
      fi
      HOMEBREW_DEVELOPER=1 brew install "$bottle"
      # Keeps `brew upgrade` from replacing this build with the upstream one.
      brew pin sapling
      echo "Installed $(sl --version | head -1)"
    fi
  fi

  if $extension; then
    if ! command -v code >/dev/null; then
      echo "skipping the VS Code extension: \`code\` is not on the PATH"
      echo "  (VS Code: Command Palette > Shell Command: Install 'code' command in PATH)"
    else
      read -r vsix_name vsix_url < <(asset .vsix) || fail "release $tag has no VS Code extension"
      vsix="$work/$vsix_name"
      curl -fsSL -o "$vsix" "$vsix_url"
      # Both extensions provide the Sapling views and commands.
      if code --list-extensions | grep -qx meta.sapling-scm; then
        code --uninstall-extension meta.sapling-scm
      fi
      code --install-extension "$vsix" --force
      echo "Installed the VS Code extension. Reload VS Code windows to use it."
    fi
  fi
}

main "$@"
