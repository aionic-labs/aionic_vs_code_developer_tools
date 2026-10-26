/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as utils from 'shared/utils';
import App from '../App';
import {
  closeCommitInfoSidebar,
  COMMIT,
  expectMessageSentToServer,
  getLastMessageOfTypeSentToServer,
  resetTestMessages,
  simulateCommits,
  simulateMessageFromServer,
  simulateRepoConnected,
  TEST_COMMIT_HISTORY,
} from '../testUtils';
import {CommandRunner} from '../types';

describe('Download Commits', () => {
  beforeEach(() => {
    resetTestMessages();
    render(<App />);

    act(() => {
      closeCommitInfoSidebar();
      simulateCommits({value: TEST_COMMIT_HISTORY});
    });
  });

  it('starts focused', () => {
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    expect(screen.getByTestId('download-commits-input')).toHaveFocus();
  });

  it('runs operation', () => {
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    act(() => {
      userEvent.type(screen.getByTestId('download-commits-input'), 'aaaaaa');
    });

    fireEvent.click(screen.getByTestId('download-commit-button'));
    expectMessageSentToServer(
      expect.objectContaining({
        type: 'runOperation',
      }),
    );
  });

  it('supports goto', async () => {
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    act(() => {
      userEvent.type(screen.getByTestId('download-commits-input'), 'aaaaaa');
      fireEvent.click(screen.getByText('Go to'));
      fireEvent.click(screen.getByText('Rebase to Stack Base'));
    });

    fireEvent.click(screen.getByTestId('download-commit-button'));

    const pullMessage = await waitFor(() =>
      utils.nullthrows(getLastMessageOfTypeSentToServer('runOperation')),
    );
    const pullId = pullMessage.operation.id;

    expectMessageSentToServer({
      type: 'runOperation',
      operation: {
        args: ['pull', '--rev', {type: 'exact-revset', revset: 'aaaaaa'}],
        runner: CommandRunner.Sapling,
        trackEventName: 'PullRevOperation',
        id: pullId,
      },
    });
    act(() =>
      simulateMessageFromServer({
        type: 'operationProgress',
        id: pullId,
        kind: 'exit',
        exitCode: 0,
        timestamp: 0,
      }),
    );
    await waitFor(() => {
      expectMessageSentToServer({
        type: 'fetchLatestCommit',
        revset: 'aaaaaa',
      });
    });
    act(() =>
      simulateMessageFromServer({
        type: 'fetchedLatestCommit',
        revset: 'aaaaaa',
        info: {value: COMMIT('aaaaaa', 'Commit A', '0', {phase: 'draft'})},
      }),
    );
    await waitFor(() =>
      expectMessageSentToServer({
        type: 'runOperation',
        operation: {
          args: [
            'rebase',
            '-s',
            {type: 'exact-revset', revset: 'aaaaaa'},
            '-d',
            {type: 'succeedable-revset', revset: '1'},
          ],
          runner: CommandRunner.Sapling,
          trackEventName: 'RebaseOperation',
          id: expect.anything(),
        },
      }),
    );
    expectMessageSentToServer({
      type: 'runOperation',
      operation: {
        args: ['goto', '--rev', {type: 'succeedable-revset', revset: 'aaaaaa'}],
        runner: CommandRunner.Sapling,
        trackEventName: 'GotoOperation',
        id: expect.anything(),
      },
    });
  });

  it('uses pr pull for GitHub pull requests so their stack is linked', async () => {
    act(() => simulateRepoConnected());
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    act(() => {
      userEvent.type(screen.getByTestId('download-commits-input'), 'pr424');
    });

    fireEvent.click(screen.getByTestId('download-commit-button'));

    const pullMessage = await waitFor(() =>
      utils.nullthrows(getLastMessageOfTypeSentToServer('runOperation')),
    );
    expect(pullMessage.operation).toEqual({
      args: ['pr', 'pull', '424'],
      runner: CommandRunner.Sapling,
      trackEventName: 'PrPullOperation',
      id: expect.anything(),
    });
    act(() =>
      simulateMessageFromServer({
        type: 'operationProgress',
        id: pullMessage.operation.id,
        kind: 'exit',
        exitCode: 0,
        timestamp: 0,
      }),
    );
    await waitFor(() => {
      expectMessageSentToServer({
        type: 'fetchLatestCommit',
        revset: 'pr424',
      });
    });
  });

  it('falls back to pull --rev when pr pull fails', async () => {
    act(() => simulateRepoConnected());
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    act(() => {
      userEvent.type(screen.getByTestId('download-commits-input'), 'pr424');
    });

    fireEvent.click(screen.getByTestId('download-commit-button'));

    const prPullMessage = await waitFor(() =>
      utils.nullthrows(getLastMessageOfTypeSentToServer('runOperation')),
    );
    act(() =>
      simulateMessageFromServer({
        type: 'operationProgress',
        id: prPullMessage.operation.id,
        kind: 'exit',
        exitCode: 255,
        timestamp: 0,
      }),
    );
    await waitFor(() =>
      expectMessageSentToServer({
        type: 'runOperation',
        operation: {
          args: ['pull', '--rev', {type: 'exact-revset', revset: 'pr424'}],
          runner: CommandRunner.Sapling,
          trackEventName: 'PullRevOperation',
          id: expect.anything(),
        },
      }),
    );
  });

  it('keyboard shortcut support', () => {
    fireEvent.click(screen.getByTestId('download-commits-tooltip-button'));

    act(() => {
      userEvent.type(screen.getByTestId('download-commits-input'), '{cmd}aaa{enter}{/cmd}');
    });

    expectMessageSentToServer(
      expect.objectContaining({
        type: 'runOperation',
        operation: expect.objectContaining({
          args: expect.arrayContaining([{type: 'exact-revset', revset: 'aaa'}]),
        }),
      }),
    );
  });
});
