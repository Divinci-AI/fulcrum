/**
 * Google Account Manager — OAuth credentials + account connection & management.
 * Used in the General/Integrations settings tab.
 * No feature toggles (calendar/gmail switches live in their own components).
 */

import { useState, useRef } from 'react'
import { toast } from 'sonner'
import { useTranslation, Trans } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Loading03Icon,
  Tick02Icon,
  Cancel01Icon,
  Add01Icon,
  Delete02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Alert02Icon,
  LinkBackwardIcon,
} from '@hugeicons/core-free-icons'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import {
  useGoogleAccounts,
  useDeleteGoogleAccount,
  useGoogleOAuthUrl,
  useUpdateGoogleAccount,
} from '@/hooks/use-google'
import { useGoogleOAuthStatus } from '@/hooks/use-config'

interface GoogleAccountManagerProps {
  clientId: string
  onClientIdChange: (value: string) => void
  clientIdSaved: boolean
  clientSecret: string
  onClientSecretChange: (value: string) => void
  clientSecretSaved: boolean
  isLoading: boolean
  onSaveCredentials?: () => Promise<void>
}

export function GoogleAccountManager({
  clientId,
  onClientIdChange,
  clientIdSaved,
  clientSecret,
  onClientSecretChange,
  clientSecretSaved,
  isLoading,
  onSaveCredentials,
}: GoogleAccountManagerProps) {
  const { t } = useTranslation('settings')
  const { data: accounts, refetch } = useGoogleAccounts()
  const deleteAccount = useDeleteGoogleAccount()
  const getOAuthUrl = useGoogleOAuthUrl()
  const { data: oauthStatus } = useGoogleOAuthStatus()
  const managedByHost = oauthStatus?.managedByHost ?? false
  const updateAccount = useUpdateGoogleAccount()
  const [showAddForm, setShowAddForm] = useState(false)
  const [accountName, setAccountName] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editedName, setEditedName] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const [reconnectingId, setReconnectingId] = useState<string | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleAddAccount = async () => {
    if (!accountName.trim()) {
      toast.error(t('google.nameRequired', 'Account name is required'))
      return
    }

    try {
      setIsConnecting(true)

      // Open window synchronously to avoid popup blocker (must be in click context)
      const popup = window.open('about:blank', '_blank', 'width=600,height=700')

      try {
        // Persist credentials before OAuth flow so the backend can read them
        await onSaveCredentials?.()

        const result = await getOAuthUrl.mutateAsync({ accountName: accountName.trim() })

        if (popup && !popup.closed) {
          popup.location.href = result.authUrl
        } else {
          // Popup was blocked or closed — fall back to same-tab redirect
          window.location.href = result.authUrl
        }
      } catch (err) {
        popup?.close()
        throw err
      }

      pollIntervalRef.current = setInterval(async () => {
        const prevCount = accounts?.length ?? 0
        await refetch()
        const newAccounts = await refetch()
        if ((newAccounts.data?.length ?? 0) > prevCount) {
          clearInterval(pollIntervalRef.current!)
          pollIntervalRef.current = null
          setIsConnecting(false)
          setShowAddForm(false)
          setAccountName('')
          toast.success(t('google.accountAdded', 'Google account connected'))
        }
      }, 2000)

      setTimeout(() => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
          setIsConnecting(false)
        }
      }, 120_000)
    } catch (err) {
      setIsConnecting(false)
      toast.error(String(err))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAccount.mutateAsync(id)
      toast.success(t('google.accountDeleted', 'Google account deleted'))
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleSaveName = async (id: string) => {
    try {
      await updateAccount.mutateAsync({ id, name: editedName })
      setEditingAccountId(null)
      toast.success(t('common.saved', 'Saved'))
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleReconnect = async (accountId: string) => {
    try {
      setReconnectingId(accountId)

      const popup = window.open('about:blank', '_blank', 'width=600,height=700')

      try {
        await onSaveCredentials?.()
        const result = await getOAuthUrl.mutateAsync({ accountId })

        if (popup && !popup.closed) {
          popup.location.href = result.authUrl
        } else {
          window.location.href = result.authUrl
        }
      } catch (err) {
        popup?.close()
        throw err
      }

      // Poll until needsReauth clears
      const reconnectPoll = setInterval(async () => {
        const { data } = await refetch()
        const account = data?.find((a) => a.id === accountId)
        if (account && !account.needsReauth) {
          clearInterval(reconnectPoll)
          setReconnectingId(null)
          toast.success(t('google.accountReconnected', 'Google account reconnected'))
        }
      }, 2000)

      setTimeout(() => {
        clearInterval(reconnectPoll)
        setReconnectingId(null)
      }, 120_000)
    } catch (err) {
      setReconnectingId(null)
      toast.error(String(err))
    }
  }

  return (
    <div className="space-y-4">
      {/* Setup Guide */}
      <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <HugeiconsIcon
            icon={guideOpen ? ArrowDown01Icon : ArrowRight01Icon}
            size={12}
            strokeWidth={2}
          />
          {t('google.setupGuideTitle', 'How to set up Google OAuth credentials')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="mt-2 ml-4 space-y-1.5 text-xs text-muted-foreground list-decimal list-outside">
            <li>
              <Trans
                i18nKey="google.setupGuideStep1"
                ns="settings"
                defaults="Go to <link>Google Cloud Console</link>"
                components={{
                  link: (
                    <a
                      href="https://console.cloud.google.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline underline-offset-2"
                    />
                  ),
                }}
              />
            </li>
            <li>{t('google.setupGuideStep2', 'Create a new project (or select an existing one)')}</li>
            <li>
              <Trans
                i18nKey="google.setupGuideStep3"
                ns="settings"
                defaults="Enable the <strong>Google Calendar API</strong> and <strong>Gmail API</strong>"
                components={{ strong: <strong className="text-foreground" /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="google.setupGuideStep4"
                ns="settings"
                defaults="Go to <strong>APIs & Services \u2192 Credentials</strong>"
                components={{ strong: <strong className="text-foreground" /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="google.setupGuideStep5"
                ns="settings"
                defaults="Create an <strong>OAuth 2.0 Client ID</strong> (type: Web application)"
                components={{ strong: <strong className="text-foreground" /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="google.setupGuideStep6"
                ns="settings"
                defaults="Add authorized redirect URI: <code>{{redirectUri}}</code>"
                values={{ redirectUri: `${window.location.origin}/api/google/oauth/callback` }}
                components={{ code: <code className="bg-muted px-1 py-0.5 rounded text-[10px]" /> }}
              />
            </li>
            <li>{t('google.setupGuideStep7', 'Copy the Client ID and Client Secret into the fields below')}</li>
          </ol>
        </CollapsibleContent>
      </Collapsible>

      {/* OAuth Credentials — hidden when the host provides them via env vars (e.g. Divinci-AI SaaS). */}
      {managedByHost ? (
        <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-4 py-3">
          <p className="text-sm font-medium">
            {t('fields.google.managedByHost', 'Google OAuth provided by your Fulcrum host')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              'fields.google.managedByHostDescription',
              'Your hosting provider supplies the Google OAuth client. Click "Add Google Account" to connect — no Google Cloud project setup required.'
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Client ID */}
          <div className="space-y-1">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                {t('fields.google.clientId', 'Google ID')}
              </label>
              <div className="flex flex-1 items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    value={clientId}
                    onChange={(e) => onClientIdChange(e.target.value)}
                    placeholder="your-app.apps.googleusercontent.com"
                    disabled={isLoading}
                    className="flex-1 pr-8 font-mono text-sm"
                  />
                  {clientIdSaved && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                      <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
              {t('fields.google.clientIdDescription', 'OAuth Client ID from Google Cloud Console')}
            </p>
          </div>

          {/* Client Secret */}
          <div className="space-y-1">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="text-sm text-muted-foreground sm:w-20 sm:shrink-0">
                {t('fields.google.clientSecret', 'Google Secret')}
              </label>
              <div className="flex flex-1 items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => onClientSecretChange(e.target.value)}
                    placeholder={t('caldav.googleClientSecretPlaceholder')}
                    disabled={isLoading}
                    className="flex-1 pr-8 font-mono text-sm"
                  />
                  {clientSecretSaved && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500">
                      <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-20 sm:pl-2">
              {t('fields.google.clientSecretDescription', 'OAuth Client Secret for Google Calendar & Gmail')}
            </p>
          </div>
        </div>
      )}

      {/* Account Management */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('google.title', 'Google Accounts')}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          <HugeiconsIcon icon={Add01Icon} className="mr-1 h-3.5 w-3.5" />
          {t('google.addAccount', 'Add Google Account')}
        </Button>
      </div>

      {showAddForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              {t('google.accountName', 'Account Name')}
            </label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="My Google Account"
              className="mt-1"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'google.oauthNote',
              'You will be redirected to Google to authorize access to Calendar and Gmail.'
            )}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={handleAddAccount}
              disabled={isConnecting || !accountName.trim()}
              size="sm"
            >
              {isConnecting ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="mr-1 h-3.5 w-3.5 animate-spin"
                  />
                  {t('google.connecting', 'Connecting...')}
                </>
              ) : (
                t('google.connect', 'Connect with Google')
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAddForm(false)
                setAccountName('')
                setIsConnecting(false)
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current)
                  pollIntervalRef.current = null
                }
              }}
            >
              {t('common:buttons.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {(!accounts || accounts.length === 0) && !showAddForm && (
        <p className="text-sm text-muted-foreground">
          {t('google.noAccounts', 'No Google accounts configured.')}
        </p>
      )}

      {accounts?.map((account) => (
        <div key={account.id} className="border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              {editingAccountId === account.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    className="h-7 text-sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName(account.id)
                      if (e.key === 'Escape') setEditingAccountId(null)
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSaveName(account.id)}
                  >
                    <HugeiconsIcon icon={Tick02Icon} className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingAccountId(null)}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div
                  className="cursor-pointer"
                  onClick={() => {
                    setEditingAccountId(account.id)
                    setEditedName(account.name)
                  }}
                >
                  <span className="font-medium text-sm">{account.name}</span>
                  {account.email && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {account.email}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(account.id)}
              title={t('google.delete', 'Delete')}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                className="h-3.5 w-3.5 text-destructive"
              />
            </Button>
          </div>
          {account.needsReauth && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 p-3">
              <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1 space-y-2">
                <p className="text-xs text-destructive">
                  {t('google.authExpired', 'Authorization expired. Reconnect to resume sync.')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleReconnect(account.id)}
                  disabled={reconnectingId === account.id}
                >
                  {reconnectingId === account.id ? (
                    <>
                      <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
                      {t('google.reconnecting', 'Reconnecting...')}
                    </>
                  ) : (
                    <>
                      <HugeiconsIcon icon={LinkBackwardIcon} className="mr-1 h-3.5 w-3.5" />
                      {t('google.reconnect', 'Reconnect')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
