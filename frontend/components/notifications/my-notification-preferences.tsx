/**
 * My Notification Preferences (D-6 PR 4).
 *
 * Surfaces the per-user override layer on top of the tenant-wide notification
 * settings. Each toggle is tri-state: `true` (always on), `false` (always
 * off), `null` (inherit tenant default). The pushover user key is a paste-in
 * secret that's age-encrypted server-side; the actual value is never echoed
 * back.
 *
 * The dispatcher integration is the follow-up (D-7) — these prefs are stored
 * and self-served today, applied to outgoing notifications once the
 * sendNotification recipient-merge lands.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HugeiconsIcon } from '@hugeicons/react'
import { Loading03Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import {
  useMyNotificationPreferences,
  useUpdateMyNotificationPreferences,
} from '@/hooks/use-notification-preferences'

type ToggleKey = 'toastEnabled' | 'desktopEnabled' | 'soundEnabled' | 'pushoverEnabled'
type TriState = 'inherit' | 'on' | 'off'

function fromTriState(v: TriState): boolean | null {
  if (v === 'inherit') return null
  return v === 'on'
}
function toTriState(v: boolean | null | undefined): TriState {
  if (v === null || v === undefined) return 'inherit'
  return v ? 'on' : 'off'
}

const TOGGLE_LABELS: Record<ToggleKey, { label: string; description: string }> = {
  toastEnabled: {
    label: 'In-app toasts',
    description: 'Small pop-ups in the corner of the UI when events fire.',
  },
  desktopEnabled: {
    label: 'Desktop notifications',
    description: "Browser/system notifications. Requires your OS to permit them.",
  },
  soundEnabled: {
    label: 'Notification sound',
    description: 'Play a sound when an event fires.',
  },
  pushoverEnabled: {
    label: 'Pushover',
    description: 'Send notifications to your Pushover account.',
  },
}

export function MyNotificationPreferences() {
  const { t } = useTranslation('settings')
  const { data: prefs, isLoading } = useMyNotificationPreferences()
  const update = useUpdateMyNotificationPreferences()
  const [pushoverKey, setPushoverKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  const handleToggleChange = (key: ToggleKey, value: TriState) => {
    update.mutate(
      { [key]: fromTriState(value) },
      {
        onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
      }
    )
  }

  const handleSavePushoverKey = async () => {
    if (!pushoverKey.trim()) return
    setSavingKey(true)
    try {
      await update.mutateAsync({ pushoverUserKey: pushoverKey.trim() })
      toast.success(t('myNotifs.pushoverSaved', 'Pushover user key saved'))
      setPushoverKey('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingKey(false)
    }
  }

  const handleClearPushoverKey = async () => {
    try {
      await update.mutateAsync({ pushoverUserKey: '' })
      toast.success(t('myNotifs.pushoverCleared', 'Pushover user key cleared'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (isLoading || !prefs) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-medium">
          {t('myNotifs.title', 'Your notification preferences')}
        </h3>
        <p className="text-xs text-muted-foreground">
          <HugeiconsIcon icon={Loading03Icon} className="inline mr-1 h-3 w-3 animate-spin" />
          {t('common:loading', 'Loading…')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {t('myNotifs.title', 'Your notification preferences')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            'myNotifs.helpText',
            'These override the tenant-wide defaults for *your* account. "Inherit" follows whatever the tenant admin has set above.'
          )}
        </p>
      </div>

      {(Object.keys(TOGGLE_LABELS) as ToggleKey[]).map((key) => {
        const meta = TOGGLE_LABELS[key]
        const current = toTriState(prefs[key])
        return (
          <div key={key} className="flex items-start justify-between gap-3 py-2 border-b last:border-b-0">
            <div className="min-w-0">
              <p className="text-sm font-medium">{meta.label}</p>
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            </div>
            <div className="flex gap-1 shrink-0">
              {(['inherit', 'on', 'off'] as TriState[]).map((opt) => (
                <Button
                  key={opt}
                  variant={current === opt ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleToggleChange(key, opt)}
                  className="capitalize"
                >
                  {opt}
                </Button>
              ))}
            </div>
          </div>
        )
      })}

      <div className="space-y-2 pt-2">
        <p className="text-sm font-medium">{t('myNotifs.pushoverKey', 'Pushover user key')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'myNotifs.pushoverHelp',
            "Each user can paste their own Pushover user key. Notifications to you go to your device, not the tenant default. Currently saved: "
          )}
          <span className={prefs.pushoverUserKeySet ? 'text-green-500' : 'text-muted-foreground'}>
            {prefs.pushoverUserKeySet ? 'yes' : 'no'}
          </span>
        </p>
        <div className="flex gap-2">
          <Input
            type="password"
            value={pushoverKey}
            onChange={(e) => setPushoverKey(e.target.value)}
            placeholder={prefs.pushoverUserKeySet ? '••••••••' : 'paste user key from pushover.net'}
            className="flex-1 font-mono text-sm"
          />
          <Button onClick={handleSavePushoverKey} disabled={savingKey || !pushoverKey.trim()} size="sm">
            {savingKey ? (
              <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <HugeiconsIcon icon={Tick02Icon} className="mr-1 h-3.5 w-3.5" />
            )}
            {t('common:buttons.save', 'Save')}
          </Button>
          {prefs.pushoverUserKeySet && (
            <Button variant="ghost" size="sm" onClick={handleClearPushoverKey}>
              {t('myNotifs.clear', 'Clear')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
