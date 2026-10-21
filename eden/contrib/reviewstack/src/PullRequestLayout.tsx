/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {AllDrawersState} from 'shared/Drawers';

import CenteredSpinner from './CenteredSpinner';
import {useCommand} from './KeyboardShortcuts';
import PullRequest from './PullRequest';
import PullRequestFiles from './PullRequestFiles';
import PullRequestHeader from './PullRequestHeader';
import PullRequestTimeline from './PullRequestTimeline';
import PullRequestTimelineCommentInput from './PullRequestTimelineCommentInput';
import {APP_HEADER_HEIGHT} from './constants';
import {gitHubOrgAndRepoAtom, gitHubPullRequestIDAtom} from './jotai';
import {Box, Text} from '@primer/react';
import {atom, useSetAtom} from 'jotai';
import React, {Component, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {Drawers} from 'shared/Drawers';

import './PullRequestLayout.css';

const HEADER_HEIGHT = 100;
const TOTAL_HEADER_HEIGHT = HEADER_HEIGHT + APP_HEADER_HEIGHT;
const COMMENT_INPUT_HEIGHT = 125;

const drawerStateAtom = atom<AllDrawersState>({
  right: {size: 500, collapsed: false},
  left: {size: 280, collapsed: false},
  top: {size: 200, collapsed: true},
  bottom: {size: 200, collapsed: true},
});

export default function PullRequestLayout({
  org,
  repo,
  number,
}: {
  org: string;
  repo: string;
  number: number;
}): React.ReactElement {
  const setOrgAndRepo = useSetAtom(gitHubOrgAndRepoAtom);
  const setPullRequestID = useSetAtom(gitHubPullRequestIDAtom);

  useEffect(() => {
    setOrgAndRepo({org, repo});
  }, [org, repo, setOrgAndRepo]);

  useEffect(() => {
    setPullRequestID(number);
  }, [number, setPullRequestID]);

  const setDrawerState = useSetAtom(drawerStateAtom);
  useCommand('ToggleSidebar', () => {
    setDrawerState(state => ({
      ...state,
      right: {...state.right, collapsed: !state.right.collapsed},
    }));
  });

  return (
    <Box>
      <PullRequestHeader height={HEADER_HEIGHT} />
      <Suspense fallback={<CenteredSpinner message="Loading pull request..." />}>
        <Drawers
          drawerState={drawerStateAtom}
          errorBoundary={ErrorBoundary}
          leftLabel={<Text className="drawer-label-text">Files</Text>}
          left={<FilesDrawer />}
          rightLabel={<Text className="drawer-label-text">Comments</Text>}
          right={<TimelineDrawer />}>
          <Box display="flex" flexDirection="row">
            <Box
              data-reviewstack-diff-scroll="true"
              height={`calc(100vh - ${TOTAL_HEADER_HEIGHT}px)`}
              overflow="auto">
              <PullRequest />
            </Box>
          </Box>
        </Drawers>
      </Suspense>
    </Box>
  );
}

function FilesDrawer() {
  return (
    <Box height={`calc(100vh - ${TOTAL_HEADER_HEIGHT}px)`} minHeight={0} overflow="hidden">
      <PullRequestFiles />
    </Box>
  );
}

function TimelineDrawer() {
  const [inputHeight, setInputHeight] = useState(loadCommentInputHeight);
  const inputHeightRef = useRef(inputHeight);
  inputHeightRef.current = inputHeight;

  const onResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = inputHeightRef.current;
    const move = (e: PointerEvent) => {
      const maxHeight = Math.round(window.innerHeight * MAX_COMMENT_INPUT_FRACTION);
      const height = Math.min(
        maxHeight,
        Math.max(MIN_COMMENT_INPUT_HEIGHT, startHeight + startY - e.clientY),
      );
      inputHeightRef.current = height;
      setInputHeight(height);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      try {
        localStorage.setItem(COMMENT_INPUT_HEIGHT_KEY, String(inputHeightRef.current));
      } catch {
        // Not persisting the height is fine.
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }, []);
  return (
    <Box display="flex" flexDirection="column" height={`calc(100vh - ${TOTAL_HEADER_HEIGHT}px)`}>
      <Box data-reviewstack-timeline-scroll="true" flexGrow={1} minHeight={0} overflow="auto">
        <PullRequestTimeline />
      </Box>
      <div
        className="timeline-input-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize comment box"
        title="Drag to resize the comment box"
        onPointerDown={onResizeStart}>
        <span aria-hidden="true">⇕</span>
      </div>
      <Box
        className="timeline-comment-input"
        display="flex"
        flexShrink={0}
        height={inputHeight}
        style={{'--timeline-input-height': `${inputHeight}px`} as React.CSSProperties}>
        <PullRequestTimelineCommentInput />
      </Box>
    </Box>
  );
}

const COMMENT_INPUT_HEIGHT_KEY = 'reviewstack.commentInputHeight';
const MIN_COMMENT_INPUT_HEIGHT = 100;
const MAX_COMMENT_INPUT_FRACTION = 0.7;

function loadCommentInputHeight(): number {
  try {
    const stored = Number(localStorage.getItem(COMMENT_INPUT_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored >= MIN_COMMENT_INPUT_HEIGHT) {
      return stored;
    }
  } catch {
    // Fall back to the default when storage is unavailable.
  }
  return COMMENT_INPUT_HEIGHT;
}

type Props = {
  children: React.ReactNode;
};

type State = {error: Error | null};

class ErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(error: Error) {
    return {error};
  }

  render() {
    return this.props.children;
  }
}
