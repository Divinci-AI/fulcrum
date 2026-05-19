import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useListUsers, type TenantUser } from '@/hooks/use-users-admin'
import { cn } from '@/lib/utils'

interface AssigneePickerProps {
  value: string | null
  onChange: (userId: string | null) => void
  className?: string
}

function userLabel(user: TenantUser): string {
  return user.displayName?.trim() || user.email
}

/**
 * Single-assignee picker for tasks. Lists tenant users from
 * `useListUsers()` (the same query the @-mention picker uses), surfaces
 * them in a popover-anchored filterable list, and saves via the existing
 * `useUpdateTask` mutation when called from task-details-panel.
 *
 * "Unassigned" is its own selectable row so users can clear an assignment
 * without dropping out to the keyboard.
 */
export function AssigneePicker({ value, onChange, className }: AssigneePickerProps) {
  const { data: users, isLoading } = useListUsers()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = users?.find((u) => u.id === value) ?? null
  const filtered = (users ?? []).filter((u) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      u.email.toLowerCase().includes(q) ||
      (u.displayName ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('w-full justify-start text-left font-normal', className)}
        >
          {selected ? userLabel(selected) : <span className="text-muted-foreground">Unassigned</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <Input
          autoFocus
          placeholder="Search users..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 mb-2"
        />
        <div className="max-h-64 overflow-y-auto">
          {/* "Unassigned" sentinel row */}
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
              setQuery('')
            }}
            className={cn(
              'w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent',
              value === null && 'bg-accent font-medium'
            )}
          >
            Unassigned
          </button>
          {isLoading && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No users match.</div>
          )}
          {filtered.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                onChange(u.id)
                setOpen(false)
                setQuery('')
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent',
                value === u.id && 'bg-accent font-medium'
              )}
            >
              <div>{userLabel(u)}</div>
              {u.displayName?.trim() && (
                <div className="text-xs text-muted-foreground">{u.email}</div>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
