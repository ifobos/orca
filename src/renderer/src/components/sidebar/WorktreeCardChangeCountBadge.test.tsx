import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const storeState: { gitStatusByWorktree?: Record<string, unknown[]> } = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState)
}))

const { WorktreeCardChangeCountBadge } = await import('./WorktreeCardChangeCountBadge')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function render(worktreeId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorktreeCardChangeCountBadge worktreeId={worktreeId} />
    </TooltipProvider>
  )
}

describe('WorktreeCardChangeCountBadge', () => {
  it('renders nothing for a clean workspace', () => {
    storeState.gitStatusByWorktree = { 'repo::/clean': [] }

    expect(render('repo::/clean')).toBe('')
  })

  it('renders nothing when status has not loaded', () => {
    storeState.gitStatusByWorktree = {}

    expect(render('repo::/unknown')).toBe('')
  })

  it('renders nothing when the status slice is absent', () => {
    // Why: sidebar rows render under partial store mocks that never populate it.
    delete storeState.gitStatusByWorktree

    expect(render('repo::/unknown')).toBe('')
  })

  it('shows the count and a singular label for one change', () => {
    storeState.gitStatusByWorktree = { 'repo::/dirty': [{}] }

    const html = render('repo::/dirty')

    expect(html).toContain('>1<')
    expect(html).toContain('1 uncommitted change')
    expect(html).not.toContain('uncommitted changes')
  })

  it('shows the count and a plural label for several changes', () => {
    storeState.gitStatusByWorktree = { 'repo::/dirty': [{}, {}, {}] }

    const html = render('repo::/dirty')

    expect(html).toContain('>3<')
    expect(html).toContain('3 uncommitted changes')
  })
})
