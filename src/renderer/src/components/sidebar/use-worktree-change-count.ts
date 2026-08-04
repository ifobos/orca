import { useAppStore } from '@/store'

/**
 * Uncommitted change count for a workspace, or 0 when its status has not loaded.
 * Reads the same per-worktree entries Source Control renders, so the sidebar
 * number can never disagree with the panel it summarizes.
 */
export function useWorktreeChangeCount(worktreeId: string): number {
  // Why: optional chaining on the slice itself — every sidebar row reads this,
  // including under partial store mocks that never populate git status.
  return useAppStore((s) => s.gitStatusByWorktree?.[worktreeId]?.length ?? 0)
}
