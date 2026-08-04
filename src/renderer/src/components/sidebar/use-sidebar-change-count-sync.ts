import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo, Worktree } from '../../../../shared/types'
import { refreshGitStatusForWorktree } from '../right-sidebar/git-status-refresh'

// Why: the sidebar summary is glanceable context, not the panel the user is
// reading, so it polls on the slow branch cadence rather than the status one.
const SIDEBAR_CHANGE_COUNT_POLL_INTERVAL_MS = 30_000
// Why: every workspace costs one `git status`, which is a subprocess locally and
// a round trip over SSH. A small window keeps a large project list from
// stampeding the host while still finishing a sweep well inside one interval.
const MAX_CONCURRENT_SWEEP_REQUESTS = 4
// Why: a build or a branch switch writes hundreds of files at once, and several
// agents can finish within the same second. Collapsing a burst into one sweep is
// the failure mode VS Code's git extension is repeatedly reported for.
const EVENT_QUIET_PERIOD_MS = 400
// Why: bounds the worst case by design. Without a floor, a steady stream of
// events could chain sweeps back to back and turn this into continuous polling
// -- exactly what measuring the cost told us not to do.
const MIN_EVENT_SWEEP_SPACING_MS = 3_000

const EMPTY_REPOS: Repo[] = []
const EMPTY_WORKTREES_BY_REPO: Record<string, Worktree[]> = {}

type PollInputs = {
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[] | undefined>
  settings: unknown
  setGitStatus: unknown
  updateWorktreeGitIdentity: unknown
  setUpstreamStatus: unknown
  fetchUpstreamStatus: unknown
}

/**
 * Keeps `gitStatusByWorktree` warm for every Git workspace listed in the
 * sidebar, so each row can show its uncommitted-change count without being
 * opened.
 */
export function useSidebarChangeCountSync({ enabled }: { enabled: boolean }): void {
  const repos = useAppStore((s) => s.repos) ?? EMPTY_REPOS
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo) ?? EMPTY_WORKTREES_BY_REPO
  const settings = useAppStore((s) => s.settings)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  // Why: agents are the main writer to workspaces the user is not looking at, so
  // an agent going live or finishing is the strongest available signal that some
  // project's tree just changed. The epoch moves on any liveness change.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch) ?? 0
  const requestEventSweepRef = useRef<() => void>(() => {})
  const lastSeenAgentEpochRef = useRef<number | null>(null)

  // Why: everything the sweep needs comes through this ref, so the effect below
  // depends only on `enabled`. Re-running it aborts in-flight `git status`
  // calls, which silently drops whichever workspaces the sweep had not reached.
  const inputsRef = useRef<PollInputs>({
    repos,
    worktreesByRepo,
    settings,
    setGitStatus,
    updateWorktreeGitIdentity,
    setUpstreamStatus,
    fetchUpstreamStatus
  })
  inputsRef.current = {
    repos,
    worktreesByRepo,
    settings,
    setGitStatus,
    updateWorktreeGitIdentity,
    setUpstreamStatus,
    fetchUpstreamStatus
  }

  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()
    let sweepInFlight = false

    const collectTargets = (): Worktree[] => {
      const inputs = inputsRef.current
      const gitRepoIds = new Set(
        inputs.repos.filter((repo) => !isFolderRepo(repo)).map((repo) => repo.id)
      )
      const targets: Worktree[] = []
      for (const worktrees of Object.values(inputs.worktreesByRepo)) {
        for (const worktree of worktrees ?? []) {
          // Folder workspaces have no Git status to summarize. The active
          // workspace is deliberately NOT skipped: Source Control only polls it
          // while the right sidebar shows that tab, so skipping it here leaves
          // the selected row -- the one most likely being looked at -- blank.
          if (!gitRepoIds.has(worktree.repoId)) {
            continue
          }
          targets.push(worktree)
        }
      }
      return targets
    }

    const refreshTarget = async (worktree: Worktree): Promise<void> => {
      const inputs = inputsRef.current
      const repo = inputs.repos.find((candidate) => candidate.id === worktree.repoId)
      if (!repo || typeof inputs.setGitStatus !== 'function') {
        return
      }
      const connectionId = getConnectionId(worktree.id) ?? undefined
      try {
        await refreshGitStatusForWorktree({
          // Why: status belongs to the repo OWNER host, not whichever runtime the
          // sidebar happens to be focused on.
          settings: getRepoOwnerRoutedSettings(
            inputs.settings as Parameters<typeof getRepoOwnerRoutedSettings>[0],
            {
              id: repo.id,
              connectionId: repo.connectionId ?? null,
              executionHostId: repo.executionHostId ?? null
            }
          ),
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          ...(connectionId ? { connectionId } : {}),
          // pushTarget is deliberately omitted: reconciling an explicit publish
          // target spawns extra Git work the count does not need.
          deps: {
            setGitStatus: inputs.setGitStatus,
            updateWorktreeGitIdentity: inputs.updateWorktreeGitIdentity,
            setUpstreamStatus: inputs.setUpstreamStatus,
            fetchUpstreamStatus: inputs.fetchUpstreamStatus
          } as Parameters<typeof refreshGitStatusForWorktree>[0]['deps'],
          request: {
            signal: controller.signal,
            shouldApply: () => !controller.signal.aborted
          }
        })
      } catch {
        // A workspace that cannot report status keeps its previous count.
      }
    }

    const sweep = async (): Promise<void> => {
      // Why: a sweep slower than the interval must not stack another one on top
      // and double every workspace's Git load. Window visibility is the
      // interval's business, not this function's.
      if (sweepInFlight || controller.signal.aborted) {
        return
      }
      sweepInFlight = true
      try {
        const targets = collectTargets()
        let nextIndex = 0
        const worker = async (): Promise<void> => {
          while (nextIndex < targets.length && !controller.signal.aborted) {
            await refreshTarget(targets[nextIndex++])
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT_SWEEP_REQUESTS, targets.length) }, worker)
        )
      } finally {
        sweepInFlight = false
      }
    }

    // Sweeps immediately, pauses while the window is hidden, and catches up as
    // soon as it is visible again -- a hidden window drops signals, so the
    // becoming-visible run is evidence-bearing rather than a bare tick.
    const uninstallInterval = installWindowVisibilityInterval({
      run: () => void sweep(),
      intervalMs: SIDEBAR_CHANGE_COUNT_POLL_INTERVAL_MS
    })

    // Why: refresh every workspace rather than guessing which one an event
    // belongs to. An agent is not confined to its own worktree -- it can write
    // anywhere by absolute path -- so scoping by path would be unsound, not just
    // more code. sweep()'s in-flight guard already collapses concurrent requests.
    let quietPeriodTimer: ReturnType<typeof setTimeout> | null = null
    let lastEventSweepAt = 0
    const requestEventSweep = (): void => {
      if (controller.signal.aborted || quietPeriodTimer) {
        return
      }
      const sinceLastSweep = Date.now() - lastEventSweepAt
      const delay = Math.max(EVENT_QUIET_PERIOD_MS, MIN_EVENT_SWEEP_SPACING_MS - sinceLastSweep)
      quietPeriodTimer = setTimeout(() => {
        quietPeriodTimer = null
        if (controller.signal.aborted) {
          return
        }
        lastEventSweepAt = Date.now()
        void sweep()
      }, delay)
    }
    requestEventSweepRef.current = requestEventSweep

    // Why: the app already watches the working tree of whatever the user has
    // open, and nothing consumed those events for Git status. Reusing them makes
    // an edit show up at once instead of on the next tick, at no watcher cost.
    // The watcher ignores .git, so commits made outside Orca still wait for the
    // interval -- that is what keeps the interval worth having.
    const unsubscribeFsChanged = window.api?.fs?.onFsChanged?.(() => requestEventSweep()) ?? null

    return () => {
      controller.abort()
      uninstallInterval()
      unsubscribeFsChanged?.()
      if (quietPeriodTimer) {
        clearTimeout(quietPeriodTimer)
      }
      requestEventSweepRef.current = () => {}
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: the mount sweep already covered the epoch we start on; only a change
    // after that means an agent moved.
    if (lastSeenAgentEpochRef.current === null) {
      lastSeenAgentEpochRef.current = agentStatusEpoch
      return
    }
    if (lastSeenAgentEpochRef.current === agentStatusEpoch) {
      return
    }
    lastSeenAgentEpochRef.current = agentStatusEpoch
    requestEventSweepRef.current()
  }, [agentStatusEpoch, enabled])
}
