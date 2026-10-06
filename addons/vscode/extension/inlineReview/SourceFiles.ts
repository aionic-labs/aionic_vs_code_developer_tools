import {spawn} from 'node:child_process';
import {readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

// Used only outside repositories. Within Git, tracked files take precedence.
const NON_SOURCE = new Set([
  '.git',
  '.sl',
  '.hg',
  'node_modules',
  '.tools',
  'artifacts',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'target',
  'build',
]);

function git(directory: string, args: string[], onPath?: (name: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', directory, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
    let remaining = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      remaining += data;
      let end: number;
      while ((end = remaining.indexOf('\0')) !== -1) {
        onPath?.(remaining.slice(0, end));
        remaining = remaining.slice(end + 1);
      }
    });
    child.stderr.on('data', data => {
      error = (error + data).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code == null || code > 1) {
        reject(new Error(`Could not enumerate source files: ${error}`));
      } else {
        resolve(code);
      }
    });
  });
}

/** All tracked and non-ignored repository files, including unopened source files. */
export class SourceFiles {
  private readonly repositories = new Set<string>();
  private readonly known = new Set<string>();

  /** Read HEAD without staging, resetting, or changing the working file. */
  committedBaseline(uri: vscode.Uri): Promise<string | undefined> {
    return new Promise(resolve => {
      const child = spawn(
        'git',
        [
          '-C',
          path.dirname(uri.fsPath),
          'show',
          '--no-ext-diff',
          '--no-textconv',
          `HEAD:./${path.basename(uri.fsPath)}`,
        ],
        {stdio: ['ignore', 'pipe', 'ignore']},
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.on('error', () => resolve(undefined));
      child.on('close', code => {
        if (code !== 0) {
          resolve(undefined);
          return;
        }
        const bytes = Buffer.concat(chunks);
        try {
          resolve(
            bytes.includes(0) ? undefined : new TextDecoder('utf-8', {fatal: true}).decode(bytes),
          );
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  async discover(): Promise<vscode.Uri[]> {
    const found = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, {withFileTypes: true});
      if (entries.some(entry => entry.name === '.git')) {
        this.repositories.add(directory);
        const paths: string[] = [];
        const code = await git(
          directory,
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          name => paths.push(path.join(directory, name)),
        );
        if (code !== 0) {
          throw new Error(`Could not list source files in ${directory}`);
        }
        for (const filename of paths) {
          // Submodules and nested repositories are returned as directories.
          // eslint-disable-next-line no-await-in-loop
          const info = await stat(filename).catch(() => undefined);
          if (info?.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await visit(filename);
          } else {
            found.add(filename);
          }
        }
        return;
      }
      for (const entry of entries) {
        if (NON_SOURCE.has(entry.name)) {
          continue;
        }
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          // eslint-disable-next-line no-await-in-loop
          await visit(filename);
        } else if (entry.isFile()) {
          found.add(filename);
        }
      }
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file') {
        // eslint-disable-next-line no-await-in-loop
        await visit(folder.uri.fsPath);
      }
    }
    for (const filename of found) {
      this.known.add(filename);
    }
    return [...found].map(filename => vscode.Uri.file(filename));
  }

  async includes(uri: vscode.Uri): Promise<boolean> {
    if (this.known.has(uri.fsPath)) {
      return true;
    }
    const repository = [...this.repositories]
      .filter(root => uri.fsPath.startsWith(root + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (repository != null) {
      return (await git(repository, ['check-ignore', '--quiet', '--', uri.fsPath])) === 1;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return (
      folder != null &&
      !path
        .relative(folder.uri.fsPath, uri.fsPath)
        .split(path.sep)
        .some(part => NON_SOURCE.has(part))
    );
  }
}
