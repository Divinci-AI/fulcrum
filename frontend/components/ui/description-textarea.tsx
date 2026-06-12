import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Textarea } from '@/components/ui/textarea'
import { uploadImage } from '@/lib/upload'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { log } from '@/lib/logger'
import { useListUsers, type TenantUser } from '@/hooks/use-users-admin'
import { findMentionTrigger, filterMentionUsers } from '@/lib/mentions'

interface DescriptionTextareaProps
  extends Omit<React.ComponentProps<'textarea'>, 'onChange' | 'value'> {
  value: string
  onValueChange: (value: string) => void
}

// Extract image paths from description text
function extractImagePaths(text: string): string[] {
  // Match absolute paths ending in common image extensions
  const pathRegex = /\/[\w\-/.]+\.(png|jpg|jpeg|gif|webp|svg)/gi
  return [...(text.match(pathRegex) || [])]
}

// Convert absolute path to API URL
function pathToUrl(path: string): string {
  const filename = path.split('/').pop()
  return `/api/uploads/${filename}`
}

// =============================================================================
// @-mention support (D-13 PR 2)
// =============================================================================
//
// When the user types `@` in the textarea, a popover anchored below the
// textarea shows a filterable list of tenant users. Selecting one replaces
// the partial `@foo` with `@<email>` (the canonical form the server's
// mention-service parser already understands).
//
// Why not anchor to caret pixel position: textarea doesn't expose caret
// coordinates and computing them requires a mirror-div trick that's
// brittle across fonts. Anchoring below the textarea is less elegant but
// dead simple and works.
//
// Trigger detection + filtering live in @/lib/mentions so TeamChat's
// composer shares the exact same behavior.

export function DescriptionTextarea({
  value,
  onValueChange,
  className,
  disabled,
  ...props
}: DescriptionTextareaProps) {
  const { t } = useTranslation('common')
  const [isUploading, setIsUploading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Mention picker state
  const { data: users } = useListUsers()
  const [mentionState, setMentionState] = useState<{ at: number; query: string } | null>(null)
  const [highlightIdx, setHighlightIdx] = useState(0)

  const imagePaths = extractImagePaths(value)
  const filteredUsers = useMemo(
    () => (users ? filterMentionUsers(users, mentionState?.query ?? '') : []),
    [users, mentionState?.query]
  )

  useEffect(() => {
    setHighlightIdx(0)
  }, [mentionState?.query])

  // Recompute mention state whenever the textarea selection changes.
  const updateMentionState = () => {
    const ta = textareaRef.current
    if (!ta) return
    const trigger = findMentionTrigger(ta.value, ta.selectionStart ?? 0)
    setMentionState(trigger)
  }

  const insertMention = (user: TenantUser) => {
    if (!mentionState) return
    const ta = textareaRef.current
    if (!ta) return
    const before = value.slice(0, mentionState.at)
    const after = value.slice((ta.selectionStart ?? 0))
    const replacement = `@${user.email} `
    const next = before + replacement + after
    onValueChange(next)
    setMentionState(null)
    // Restore cursor after the inserted mention (after the trailing space).
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const pos = before.length + replacement.length
      node.setSelectionRange(pos, pos)
      node.focus()
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState && filteredUsers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => (i + 1) % filteredUsers.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => (i - 1 + filteredUsers.length) % filteredUsers.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredUsers[highlightIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionState(null)
        return
      }
    }
    // Forward to any caller-supplied handler.
    props.onKeyDown?.(e)
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) return

        setIsUploading(true)
        try {
          const path = await uploadImage(file)
          // Insert path at cursor position or append
          const textarea = textareaRef.current
          if (textarea) {
            const start = textarea.selectionStart
            const end = textarea.selectionEnd
            const before = value.slice(0, start)
            const after = value.slice(end)
            // Add newlines if not at start/end of content
            const prefix = before && !before.endsWith('\n') ? '\n' : ''
            const suffix = after && !after.startsWith('\n') ? '\n' : ''
            const newValue = before + prefix + path + suffix + after
            onValueChange(newValue)
          } else {
            onValueChange(value + (value ? '\n' : '') + path)
          }
        } catch (error) {
          toast.error(t('errors.imageUploadFailed'))
          log.kanban.error('Upload error', { error: String(error) })
        } finally {
          setIsUploading(false)
        }
        return
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value)
            // Defer mention-state recompute so the value prop has settled.
            requestAnimationFrame(updateMentionState)
          }}
          onKeyUp={updateMentionState}
          onClick={updateMentionState}
          onBlur={() => {
            // Close mention picker on blur — but small delay so click-to-select fires first.
            setTimeout(() => setMentionState(null), 150)
          }}
          onPaste={handlePaste}
          className={cn(isUploading && 'opacity-50', className)}
          disabled={isUploading || disabled}
          {...props}
          // onKeyDown last so it overrides any caller-supplied handler;
          // handleKeyDown forwards to props.onKeyDown when it doesn't
          // intercept a key (e.g. when the mention picker is closed).
          onKeyDown={handleKeyDown}
        />
        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded-md">
            <span className="text-sm text-muted-foreground">{t('status.uploading')}</span>
          </div>
        )}
        {mentionState && filteredUsers.length > 0 && (
          <div className="absolute z-50 mt-1 w-72 rounded-md border bg-popover p-1 shadow-md">
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Mention a user — ↑↓ to navigate, Enter to select, Esc to dismiss
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredUsers.map((u, idx) => (
                <button
                  key={u.id}
                  type="button"
                  // Use mousedown not click so it fires before the textarea's blur.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    insertMention(u)
                  }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded text-sm',
                    idx === highlightIdx ? 'bg-accent' : 'hover:bg-accent'
                  )}
                >
                  <div>{u.displayName?.trim() || u.email}</div>
                  {u.displayName?.trim() && (
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {imagePaths.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imagePaths.map((path, idx) => (
            <a
              key={idx}
              href={pathToUrl(path)}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={pathToUrl(path)}
                alt={`Attachment ${idx + 1}`}
                className="h-16 w-auto rounded border object-cover hover:opacity-80 transition-opacity"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
