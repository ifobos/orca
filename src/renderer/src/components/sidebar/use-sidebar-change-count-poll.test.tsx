// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refreshGitStatusForWorktree = vi.fn()
const setGitStatus = vi.fn()
const updateWorktreeGitIdentity = vi.fn()
const setUpstreamStatus = vi.fn()
const fetchUpstreamStatus = vi.fn()

type StoreShape = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  settings: unknown
  setGitStatus: unknown
  updateWorktreeGitIdentity: unknown
  setUpstreamStatus: unknown
  fetchUpstreamStatus: unknown
}

let storeState: StoreShape
let root: Root | null = null
let container: HTMLDivElement | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState)
}))

vi.mock('../right-sidebar/git-status-refresh', () => ({
  refreshGitStatusForWorktree: (args: unknown) => refreshGitStatusForWorktree(args)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: (worktreeId: string) => (worktreeId.startsWith('ssh-') ? 'ssh-1' : null)
}))

vi.mock('@/lib/repo-runtime-owner', () => ({
  getRepoOwnerRoutedSettings: (settings: unknown, repo: unknown) => ({ routedFor: repo, settings })
}))

const { useSidebarChangeCountPoll } = await import('./use-sidebar-change-count-poll')

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeWorktree(repoId: string, path: string): Worktree {
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    displayName: path,
    branch: 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  } as Worktree
}

function Probe({ enabled }: { enabled: boolean }): null {
  useSidebarChangeCountPoll({ enabled })
  return null
}

async function mount(enabled = true): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe enabled={enabled} />)
  })
}

async function rerender(enabled: boolean): Promise<void> {
  await act(async () => {
    root?.render(<Probe enabled={enabled} />)
  })
}

function polledPaths(): string[] {
  return refreshGitStatusForWorktree.mock.calls
    .map((call) => (call[0] as { worktreePath: string }).worktreePath)
    .sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  refreshGitStatusForWorktree.mockResolvedValue(undefined)
  storeState = {
    repos: [makeRepo('git-1'), makeRepo('git-2')],
    worktreesByRepo: {
      'git-1': [makeWorktree('git-1', '/repos/git-1')],
      'git-2': [makeWorktree('git-2', '/repos/git-2')]
    },
    settings: { theme: 'dark' },
    setGitStatus,
    updateWorktreeGitIdentity,
    setUpstreamStatus,
    fetchUpstreamStatus
  }
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
})

describe('useSidebarChangeCountPoll', () => {
  it('sweeps every Git workspace on mount', async () => {
    await mount()

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('does not skip the active workspace', async () => {
    // Why: Source Control only polls the active workspace while the right sidebar
    // shows its tab, so skipping it here blanks the selected row's count.
    ;(storeState as StoreShape & { activeWorktreeId?: string }).activeWorktreeId =
      'git-1::/repos/git-1'

    await mount()

    expect(polledPaths()).toContain('/repos/git-1')
  })

  it('skips folder workspaces, which have no Git status', async () => {
    storeState.repos = [
      makeRepo('git-1'),
      makeRepo('folder-1', { kind: 'folder' } as Partial<Repo>)
    ]
    storeState.worktreesByRepo = {
      'git-1': [makeWorktree('git-1', '/repos/git-1')],
      'folder-1': [makeWorktree('folder-1', '/repos/folder-1')]
    }

    await mount()

    expect(polledPaths()).toEqual(['/repos/git-1'])
  })

  it('does nothing while disabled', async () => {
    await mount(false)

    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('routes each workspace through its own repo owner settings', async () => {
    await mount()

    const routed = refreshGitStatusForWorktree.mock.calls.map(
      (call) => (call[0] as { settings: { routedFor: { id: string } } }).settings.routedFor.id
    )
    expect(routed.sort()).toEqual(['git-1', 'git-2'])
  })

  it('passes the SSH connection id when the workspace has one', async () => {
    storeState.repos = [makeRepo('ssh-repo')]
    storeState.worktreesByRepo = { 'ssh-repo': [makeWorktree('ssh-repo', '/srv/app')] }

    await mount()

    // getConnectionId is mocked to answer for ssh-prefixed worktree ids.
    expect(refreshGitStatusForWorktree.mock.calls[0][0]).toMatchObject({ connectionId: 'ssh-1' })
  })

  it('polls again on the interval', async () => {
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('skips the sweep while the window is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })

    await mount()

    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('sweeps immediately when the window becomes visible again', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await mount()
    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('caps how many workspaces it queries at once', async () => {
    const repoIds = Array.from({ length: 12 }, (_, index) => `git-${index}`)
    storeState.repos = repoIds.map((id) => makeRepo(id))
    storeState.worktreesByRepo = Object.fromEntries(
      repoIds.map((id) => [id, [makeWorktree(id, `/repos/${id}`)]])
    )
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(() => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight -= 1
          resolve()
        })
      })
    })

    await mount()

    expect(peak).toBe(4)
    await act(async () => {
      while (releases.length > 0) {
        releases.shift()?.()
        await Promise.resolve()
      }
    })
  })

  it('does not stack a second sweep on top of a slow one', async () => {
    // Why: a sweep slower than the interval would otherwise double every
    // workspace's Git load on each tick.
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    )

    await mount()
    // Both workspaces belong to the first sweep, which never settles below.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })

    // Three interval ticks passed and none of them started a second sweep.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    await act(async () => {
      releases.forEach((resolve) => resolve())
    })
  })

  it('aborts in-flight requests when it unmounts', async () => {
    await mount()
    const signal = (
      refreshGitStatusForWorktree.mock.calls[0][0] as {
        request: { signal: AbortSignal }
      }
    ).request.signal
    expect(signal.aborted).toBe(false)

    await act(async () => {
      root?.unmount()
    })
    root = null

    expect(signal.aborted).toBe(true)
  })

  it('keeps sweeping across re-renders that only change store action identity', async () => {
    // Why: the effect used to depend on the store setters; a new identity restarted
    // it, and the abort dropped whichever workspaces the sweep had not reached.
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    const firstSignal = (
      refreshGitStatusForWorktree.mock.calls[0][0] as {
        request: { signal: AbortSignal }
      }
    ).request.signal

    storeState = { ...storeState, setGitStatus: vi.fn(), fetchUpstreamStatus: vi.fn() }
    await rerender(true)

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(false)
  })
})
