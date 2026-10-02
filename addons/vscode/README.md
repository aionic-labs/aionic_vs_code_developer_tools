# Aionic Sapling

This Aionic fork adds local inline change review: per-change Accept/Reject controls,
red/green previews, and navigation between changes and files. See
[Inline Review](./INLINE_REVIEW.md) for setup, shortcuts, snapshot semantics, and limits.

The extension retains the Sapling integrations below. Local review does not stage,
commit, push, or submit changes.

[Sapling](https://sapling-scm.com/) is a Scalable, User-Friendly Source Control System.

This extension provides integrations with Sapling, including a webview Interactive Smartlog UI as you would get by running [`sl web`](https://sapling-scm.com/docs/commands/web/):

To launch it, you can either:

- Run the **Sapling SCM: Open Interactive Smartlog** command from the [command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette).
- [Define your own keyboard shortcut](https://code.visualstudio.com/docs/getstarted/keybindings) to run the `sapling.open-isl` command.

More information about this extension can be found [on the Sapling website](https://sapling-scm.com/docs/addons/vscode).

**Note: This extension does not include Sapling SCM itself.** You must install Sapling SCM through the [normal installation instructions](https://sapling-scm.com/docs/introduction/installation)
in order for the VS Code extension to work.
