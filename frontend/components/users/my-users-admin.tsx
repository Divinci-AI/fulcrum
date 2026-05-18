/**
 * Tenant member management (D-8 PR 2).
 *
 * Admin-only Settings section. Lists every user in this tenant, lets an
 * admin invite a new one (pre-creates the row before their first CF Access
 * sign-in), and toggles the admin flag.
 *
 * "Invited but never logged in" — i.e. `lastSeenAt === null` — gets a
 * faded "invited" badge so admins can see who hasn't shown up yet. The
 * mention/assignee pickers consume the same list so the invitee is
 * `@`-able immediately.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { HugeiconsIcon } from '@hugeicons/react'
import { Delete02Icon, Loading03Icon, Mail01Icon, UserAdd01Icon } from '@hugeicons/core-free-icons'
import { useCurrentUser } from '@/hooks/use-current-user'
import {
  useDeleteUser,
  useEmailDeliveryStatus,
  useInviteUser,
  useListUsers,
  useResendInvite,
  useSetUserAdmin,
  type TenantUser,
  type UserDeliveryStatus,
} from '@/hooks/use-users-admin'

/** D-11 PR 5: format the bounce-reason short enough for a tooltip. */
function deliveryBadgeLabel(s: UserDeliveryStatus): string {
  if (s.eventType === 'bounced') return 'bounced'
  if (s.eventType === 'complained') return 'spam complaint'
  if (s.eventType === 'deferred') return 'deferred'
  return s.eventType
}
function deliveryBadgeTitle(s: UserDeliveryStatus): string {
  const when = new Date(s.occurredAt).toLocaleString()
  return `${s.eventType} at ${when}${s.reason ? ` — ${s.reason}` : ''}`
}

function formatLastSeen(value: string | null): string {
  if (!value) return 'invited'
  const d = new Date(value)
  return `seen ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export function MyUsersAdmin() {
  const { data: currentUser } = useCurrentUser()
  const { data: users, isLoading } = useListUsers()
  const { data: deliveryStatus } = useEmailDeliveryStatus()
  const inviteUser = useInviteUser()
  const setUserAdmin = useSetUserAdmin()
  const resendInvite = useResendInvite()
  const deleteUser = useDeleteUser()

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteAsAdmin, setInviteAsAdmin] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleInvite = async () => {
    const email = inviteEmail.trim()
    if (!email) return
    try {
      const { user, cfAccess, inviteEmail: inviteEmailResult } = await inviteUser.mutateAsync({
        email,
        isAdmin: inviteAsAdmin || undefined,
      })
      setInviteEmail('')
      setInviteAsAdmin(false)
      // D-8 PR 6 + D-9 PR 2: combine CF Access + invite email results
      // in a single toast so the admin sees both outcomes at a glance.
      const fragments: string[] = []
      if (cfAccess.configured) {
        if (cfAccess.ok) fragments.push('CF Access policy updated')
        else fragments.push(`CF Access update failed: ${cfAccess.reason ?? 'unknown'}`)
      }
      if (inviteEmailResult.drafted) {
        if (inviteEmailResult.mode === 'cloudflare') {
          // D-10 PR 9: surface delivered vs queued so the admin knows
          // whether the recipient's mail server already accepted it.
          const verb = inviteEmailResult.delivery === 'queued'
            ? 'queued for delivery via Cloudflare'
            : 'sent via Cloudflare'
          fragments.push(`invite email ${verb}`)
        } else {
          fragments.push('invite email drafted — review in Gmail')
        }
      } else if (inviteEmailResult.mode === 'cloudflare') {
        // CF configured but the send failed — bounce or transport error.
        const tag = inviteEmailResult.delivery === 'bounced' ? 'bounced' : 'failed'
        fragments.push(`Cloudflare Email ${tag}: ${inviteEmailResult.reason ?? 'unknown'}`)
      }
      const detail = fragments.length > 0 ? ` (${fragments.join('; ')})` : ''
      const cfFailed = cfAccess.configured && !cfAccess.ok
      if (cfFailed) {
        toast.warning(`Invited ${user.email}${detail}. Add the email manually in the Cloudflare dashboard.`)
      } else {
        toast.success(`Invited ${user.email}${detail}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleAdmin = async (target: TenantUser, isAdmin: boolean) => {
    setTogglingId(target.id)
    try {
      await setUserAdmin.mutateAsync({ id: target.id, isAdmin })
      toast.success(`${target.email} is now ${isAdmin ? 'an admin' : 'a member'}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTogglingId(null)
    }
  }

  const handleResend = async (target: TenantUser) => {
    setResendingId(target.id)
    try {
      const { inviteEmail: result } = await resendInvite.mutateAsync(target.id)
      if (result.drafted) {
        if (result.mode === 'cloudflare') {
          const verb = result.delivery === 'queued' ? 're-queued via Cloudflare' : 're-sent via Cloudflare'
          toast.success(`Invite email ${verb} to ${target.email}`)
        } else {
          toast.success(`Invite email re-drafted for ${target.email} — review in Gmail`)
        }
      } else {
        const tag = result.delivery === 'bounced' ? 'bounced' : 'failed'
        toast.warning(`Invite ${tag} for ${target.email}: ${result.reason ?? 'unknown'}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setResendingId(null)
    }
  }

  const handleDelete = async (target: TenantUser) => {
    // Confirm — delete is destructive (tokens revoked, mentions removed,
    // channel-message attribution cleared). Native confirm is fine here;
    // sortable shadcn dialog would be polish.
    if (!window.confirm(`Remove ${target.email}? This revokes their API tokens, channel routes, mentions, and notification prefs. Channel-message history is preserved but un-attributed.`)) {
      return
    }
    setDeletingId(target.id)
    try {
      const { cleanup } = await deleteUser.mutateAsync(target.id)
      const counts = Object.entries(cleanup)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
      toast.success(`Removed ${target.email}${counts ? ` (${counts})` : ''}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingId(null)
    }
  }

  const sorted = [...(users ?? [])].sort((a, b) => a.email.localeCompare(b.email))

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Members</h3>
        <p className="text-xs text-muted-foreground">
          Invite teammates by email so they appear in mention pickers and
          assignment dropdowns before their first sign-in. When the
          per-user CF Access policy is configured (see
          <code className="mx-1">integrations.cloudflareAccessAppId</code> /
          <code className="mx-1">.cloudflareAccessPolicyId</code>),
          invites automatically open the edge for non-Divincian addresses.
          Otherwise the local row is created and the admin adds the email
          to Cloudflare Access manually.
        </p>
      </div>

      <div className="border rounded-lg p-3 space-y-3">
        <p className="text-sm font-medium">Invite a member</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@divinci.ai"
            type="email"
            className="flex-1 font-mono text-sm"
          />
          <div className="flex items-center gap-2">
            <Switch
              checked={inviteAsAdmin}
              onCheckedChange={setInviteAsAdmin}
              id="invite-as-admin"
            />
            <label
              htmlFor="invite-as-admin"
              className="text-xs text-muted-foreground select-none"
            >
              Admin
            </label>
          </div>
          <Button
            onClick={handleInvite}
            disabled={inviteUser.isPending || !inviteEmail.trim()}
            size="sm"
          >
            {inviteUser.isPending ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                className="mr-1 h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <HugeiconsIcon icon={UserAdd01Icon} className="mr-1 h-3.5 w-3.5" />
            )}
            Invite
          </Button>
        </div>
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">
          <HugeiconsIcon
            icon={Loading03Icon}
            className="inline mr-1 h-3 w-3 animate-spin"
          />
          Loading members…
        </p>
      )}

      <div className="border rounded-lg divide-y">
        {sorted.map((u) => {
          const isSelf = currentUser?.id === u.id
          const invited = u.lastSeenAt === null
          return (
            <div
              key={u.id}
              className="flex items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">
                    {u.displayName || u.email}
                  </p>
                  {/* D-11 PR 5: bounce/complaint badge if the most
                      recent delivery event for this user's email was
                      a permanent failure. Hovered tooltip shows the
                      provider's reason + timestamp. */}
                  {(() => {
                    const status = deliveryStatus?.get(u.id)
                    if (!status) return null
                    if (status.eventType !== 'bounced' && status.eventType !== 'complained') {
                      return null
                    }
                    return (
                      <span
                        className="text-[10px] uppercase tracking-wide bg-destructive/15 text-destructive px-1.5 py-0.5 rounded-md shrink-0"
                        title={deliveryBadgeTitle(status)}
                      >
                        {deliveryBadgeLabel(status)}
                      </span>
                    )
                  })()}
                </div>
                {u.displayName && (
                  <p className="text-xs text-muted-foreground truncate">
                    {u.email}
                  </p>
                )}
                <p
                  className={`text-[11px] ${invited ? 'text-muted-foreground/60 italic' : 'text-muted-foreground'}`}
                >
                  {formatLastSeen(u.lastSeenAt)}
                  {isSelf ? ' · you' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* Resend only makes sense for invited rows (never seen);
                    once they've logged in they don't need a re-invite. */}
                {invited && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleResend(u)}
                    disabled={resendingId === u.id}
                    title="Resend invite email"
                  >
                    {resendingId === u.id ? (
                      <HugeiconsIcon icon={Loading03Icon} className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <HugeiconsIcon icon={Mail01Icon} className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
                {/* Self-row hides the destructive button entirely; the
                    server's last-admin guard catches the policy edge. */}
                {!isSelf && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleDelete(u)}
                    disabled={deletingId === u.id}
                    title="Remove member"
                  >
                    {deletingId === u.id ? (
                      <HugeiconsIcon icon={Loading03Icon} className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5 text-destructive" />
                    )}
                  </Button>
                )}
                <label className="text-xs text-muted-foreground select-none">
                  Admin
                </label>
                <Switch
                  checked={u.isAdmin}
                  onCheckedChange={(v) => handleToggleAdmin(u, v)}
                  disabled={togglingId === u.id}
                />
              </div>
            </div>
          )
        })}
        {!isLoading && sorted.length === 0 && (
          <p className="text-xs text-muted-foreground p-3">No members yet.</p>
        )}
      </div>
    </div>
  )
}
