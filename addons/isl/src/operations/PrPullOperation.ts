/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Operation} from './Operation';

/**
 * Pulls a GitHub pull request and links it, and the pull requests below it in
 * its Sapling stack, to their commits.
 */
export class PrPullOperation extends Operation {
  static opName = 'pr pull';

  constructor(private prNumber: number) {
    super('PrPullOperation');
  }

  getArgs() {
    return ['pr', 'pull', String(this.prNumber)];
  }
}
