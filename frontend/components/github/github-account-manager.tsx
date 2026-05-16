/**
 * GitHub Account Manager (D-6 PR 2 frontend).
 *
 * Mirror of `<GoogleAccountManager />` for GitHub identities. The
 * difference: GitHub uses pasted PATs (no OAuth dance), so the form is
 * simpler — label + token + submit. Validation happens server-side; we
 * surface the GitHub-API error inline on failure.
 *
 * Per-row actions: rotate PAT (replace the stored token), rename, delete.
 * Each row shows the resolved GitHub login + avatar fetched by the
 * backend at validation time.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  Edit02Icon,
  Loading03Icon,
  RotateLeft01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import {
  useGithubAccounts,
  useCreateGithubAccount,
  useDeleteGithubAccount,
  useUpdateGithubAccount,
  type GithubAccount,
} from '@/hooks/use-github-accounts'

type Mode = 'view' | 'add' | { kind: 'rotate' | 'rename'; id: string }

export function GitHubAccountManager() {
  const { t } = useTranslation('settings')
  const { data: accounts, isLoading } = useGithubAccounts()
  const createAccount = useCreateGithubAccount()
  const updateAccount = useUpdateGithubAccount()
  const deleteAccount = useDeleteGithubAccount()

  const [mode, setMode] = useState<Mode>('view')
  const [label, setLabel] = useState('')
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)

  const resetForm = () => {
    setLabel('')
    setPat('')
    setMode('view')
  }

  const handleCreate = async () => {
    if (!label.trim() || !pat.trim()) return
    try {
      setBusy(true)
      await createAccount.mutateAsync({ label: label.trim(), pat: pat.trim() })
      toast.success(t('github.added', 'GitHub account added'))
      resetForm()
    } catch (err) {
      toast.error(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRotate = async (id: string) => {
    if (!pat.trim()) return
    try {
      setBusy(true)
      await updateAccount.mutateAsync({ id, pat: pat.trim() })
      toast.success(t('github.rotated', 'PAT rotated'))
      resetForm()
    } catch (err) {
      toast.error(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async (id: string) => {
    if (!label.trim()) return
    try {
      setBusy(true)
      await updateAccount.mutateAsync({ id, label: label.trim() })
      toast.success(t('github.renamed', 'Account renamed'))
      resetForm()
    } catch (err) {
      toast.error(extractError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAccount.mutateAsync(id)
      toast.success(t('github.deleted', 'GitHub account removed'))
    } catch (err) {
      toast.error(extractError(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('github.accountsTitle', 'GitHub Accounts')}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (mode === 'add' ? resetForm() : setMode('add'))}
        >
          <HugeiconsIcon icon={Add01Icon} className="mr-1 h-3.5 w-3.5" />
          {t('github.addAccount', 'Add PAT')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          'github.helpText',
          'Paste a GitHub Personal Access Token. Each tenant member adds their own — PR comments and issue activity attribute to the owning user. Create one at github.com/settings/tokens.'
        )}
      </p>

      {mode === 'add' && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('github.labelField', 'Label')}
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('github.labelPlaceholder', 'personal, work, ...')}
              className="mt-1"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('github.patField', 'Personal Access Token')}
            </label>
            <Input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="ghp_..."
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleCreate} disabled={busy || !label.trim() || !pat.trim()} size="sm">
              {busy ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
                  {t('github.validating', 'Validating…')}
                </>
              ) : (
                t('github.connect', 'Add')
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={resetForm}>
              {t('common:buttons.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {!isLoading && (!accounts || accounts.length === 0) && mode !== 'add' && (
        <p className="text-sm text-muted-foreground">
          {t('github.noAccounts', 'No GitHub accounts configured.')}
        </p>
      )}

      {accounts?.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          mode={mode}
          label={label}
          pat={pat}
          busy={busy}
          onLabelChange={setLabel}
          onPatChange={setPat}
          onStartRotate={() => {
            setPat('')
            setMode({ kind: 'rotate', id: account.id })
          }}
          onStartRename={() => {
            setLabel(account.label)
            setMode({ kind: 'rename', id: account.id })
          }}
          onCancel={resetForm}
          onSubmitRotate={() => handleRotate(account.id)}
          onSubmitRename={() => handleRename(account.id)}
          onDelete={() => handleDelete(account.id)}
        />
      ))}
    </div>
  )
}

function AccountRow({
  account,
  mode,
  label,
  pat,
  busy,
  onLabelChange,
  onPatChange,
  onStartRotate,
  onStartRename,
  onCancel,
  onSubmitRotate,
  onSubmitRename,
  onDelete,
}: {
  account: GithubAccount
  mode: Mode
  label: string
  pat: string
  busy: boolean
  onLabelChange: (v: string) => void
  onPatChange: (v: string) => void
  onStartRotate: () => void
  onStartRename: () => void
  onCancel: () => void
  onSubmitRotate: () => void
  onSubmitRename: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const isRotating = typeof mode === 'object' && mode.kind === 'rotate' && mode.id === account.id
  const isRenaming = typeof mode === 'object' && mode.kind === 'rename' && mode.id === account.id

  const validatedAgo = account.lastValidatedAt
    ? new Date(account.lastValidatedAt).toLocaleString()
    : t('github.unvalidated', 'Not validated yet')

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {account.githubAvatarUrl ? (
            <img
              src={account.githubAvatarUrl}
              alt={account.githubLogin ?? account.label}
              className="h-8 w-8 rounded-full"
            />
          ) : (
            <div className="h-8 w-8 rounded-full bg-muted" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{account.label}</span>
              {account.label === 'imported' && (
                <span className="text-[10px] uppercase tracking-wide bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 rounded px-1.5 py-0.5">
                  {t('github.importedBadge', 'imported')}
                </span>
              )}
            </div>
            {account.githubLogin && (
              <a
                href={`https://github.com/${account.githubLogin}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:underline"
              >
                @{account.githubLogin}
              </a>
            )}
            <p className="text-[10px] text-muted-foreground">
              {t('github.lastValidated', 'Validated')}: {validatedAgo}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onStartRotate}
            title={t('github.rotate', 'Rotate PAT')}
          >
            <HugeiconsIcon icon={RotateLeft01Icon} className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onStartRename}
            title={t('github.rename', 'Rename')}
          >
            <HugeiconsIcon icon={Edit02Icon} className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onDelete}
            title={t('github.delete', 'Delete')}
          >
            <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {isRotating && (
        <div className="space-y-2 border-t pt-3">
          <label className="text-xs text-muted-foreground">
            {t('github.newPat', 'New Personal Access Token')}
          </label>
          <Input
            type="password"
            value={pat}
            onChange={(e) => onPatChange(e.target.value)}
            placeholder="ghp_..."
            className="font-mono text-sm"
            autoFocus
          />
          <div className="flex gap-2">
            <Button onClick={onSubmitRotate} disabled={busy || !pat.trim()} size="sm">
              {busy ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
                  {t('github.validating', 'Validating…')}
                </>
              ) : (
                <>
                  <HugeiconsIcon icon={Tick02Icon} className="mr-1 h-3.5 w-3.5" />
                  {t('github.saveRotation', 'Replace token')}
                </>
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <HugeiconsIcon icon={Cancel01Icon} className="mr-1 h-3.5 w-3.5" />
              {t('common:buttons.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {isRenaming && (
        <div className="space-y-2 border-t pt-3">
          <label className="text-xs text-muted-foreground">
            {t('github.labelField', 'Label')}
          </label>
          <Input
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder={t('github.labelPlaceholder', 'personal, work, ...')}
            autoFocus
          />
          <div className="flex gap-2">
            <Button onClick={onSubmitRename} disabled={busy || !label.trim()} size="sm">
              {busy ? (
                <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <HugeiconsIcon icon={Tick02Icon} className="mr-1 h-3.5 w-3.5" />
              )}
              {t('common:buttons.save', 'Save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <HugeiconsIcon icon={Cancel01Icon} className="mr-1 h-3.5 w-3.5" />
              {t('common:buttons.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function extractError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}
