#!/usr/bin/env bash
# Installs the Aionic Sapling CLI and VS Code extension from a GitHub release of
# this repository. Run it again to update. Needs the GitHub CLI, logged in.
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
  local repo=aionic-labs/aionic_vs_code_developer_tools
  local tag="" cli=true extension=true force=false

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

  [[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] ||
    fail "the release has a CLI build for macOS on Apple silicon only"
  command -v gh >/dev/null || fail "install the GitHub CLI and run gh auth login"
  if $cli; then
    command -v brew >/dev/null || fail "install Homebrew first: https://brew.sh"
  fi

  # Global, so the EXIT trap still sees it after main returns.
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  # Without a tag, gh picks the latest release, which skips prereleases.
  gh release download ${tag:+"$tag"} --repo "$repo" --dir "$work" \
    --pattern '*.bottle.tar.gz' --pattern '*.vsix'

  if $cli; then
    local bottle version installed
    bottle=$(echo "$work"/sapling-*.bottle.tar.gz)
    version=${bottle##*/sapling-}
    version=${version%%.arm64_*}
    installed=$(brew list --versions sapling 2>/dev/null | awk '{print $2}' || true)
    if [[ $installed == "$version" ]] && ! $force; then
      echo "sl $version is already installed"
    else
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
      # Both extensions provide the Sapling views and commands.
      if code --list-extensions | grep -qx meta.sapling-scm; then
        code --uninstall-extension meta.sapling-scm
      fi
      code --install-extension "$(echo "$work"/*.vsix)" --force
      echo "Installed the VS Code extension. Reload VS Code windows to use it."
    fi
  fi
}

fail() {
  echo "error: $*" >&2
  exit 1
}

main "$@"
