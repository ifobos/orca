import React from 'react'
import { FileDiff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useWorktreeChangeCount, useWorktreeChangeCountIsCapped } from './use-worktree-change-count'

/**
 * Uncommitted-change count for a sidebar row. Renders nothing at zero, so a
 * clean workspace stays quiet and any badge at all means "this one has work in
 * it" before the number is even read.
 */
export function WorktreeCardChangeCountBadge({
  worktreeId,
  className
}: {
  worktreeId: string
  className?: string
}): React.JSX.Element | null {
  const changeCount = useWorktreeChangeCount(worktreeId)
  const isCapped = useWorktreeChangeCountIsCapped(worktreeId)
  if (changeCount === 0) {
    return null
  }
  const label = isCapped
    ? // Why a floor rather than a total: git was stopped at the cap, so the real
      // number is unknown. Source Control says the same thing in its own words.
      translate(
        'auto.components.sidebar.WorktreeCardChangeCountBadge.atLeastUncommittedChanges',
        'At least {{value0}} uncommitted changes',
        { value0: changeCount }
      )
    : changeCount === 1
      ? translate(
          'auto.components.sidebar.WorktreeCardChangeCountBadge.oneUncommittedChange',
          '1 uncommitted change'
        )
      : translate(
          'auto.components.sidebar.WorktreeCardChangeCountBadge.uncommittedChanges',
          '{{value0}} uncommitted changes',
          { value0: changeCount }
        )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why: the row's trailing cluster is bare icons at size-3.5 in one muted
            tone, so a bordered pill here reads as misaligned next to them. */}
        <span
          data-worktree-change-count=""
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium leading-none tabular-nums text-muted-foreground/70',
            className
          )}
        >
          <FileDiff className="size-3.5" aria-hidden="true" />
          <span>{isCapped ? `${changeCount}+` : changeCount}</span>
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{label}</span>
      </TooltipContent>
    </Tooltip>
  )
}
