import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { HugeiconsIcon } from '@hugeicons/react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { useListUsers } from '@/hooks/use-users-admin'
import { fetchJSON } from '@/lib/api'

interface AclGrant {
  id: string
  resourceType: 'task' | 'project'
  resourceId: string
  principalType: 'user' | 'team'
  principalId: string
  role: 'viewer' | 'editor' | 'admin'
  grantedAt: string
  grantedBy: string | null
}

interface ProjectMembersPanelProps {
  projectId: string
  visibility: 'tenant' | 'restricted'
}

const ROLES = ['viewer', 'editor', 'admin'] as const

/**
 * Project sharing panel: visibility toggle, member list (ACL grants), and
 * invite-by-email. Grants on the project cascade to its tasks server-side,
 * so "invite to this project" is the whole story — no per-task grants
 * needed for members.
 */
export function ProjectMembersPanel({ projectId, visibility }: ProjectMembersPanelProps) {
  const queryClient = useQueryClient()
  const { data: users } = useListUsers()
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<(typeof ROLES)[number]>('editor')

  const { data: grants } = useQuery({
    queryKey: ['acls', 'project', projectId],
    queryFn: () =>
      fetchJSON<{ acls: AclGrant[] }>(
        `/api/acls?resourceType=project&resourceId=${projectId}`
      ).then((r) => r.acls),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['acls', 'project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  const invite = useMutation({
    mutationFn: () =>
      fetchJSON<{ provisioned: boolean; inviteEmail: { drafted: boolean; mode: string } }>(
        `/api/projects/${projectId}/invites`,
        {
          method: 'POST',
          body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        }
      ),
    onSuccess: (result) => {
      setInviteEmail('')
      invalidate()
      const emailNote =
        result.inviteEmail.mode === 'cloudflare'
          ? 'Invite email sent.'
          : result.inviteEmail.mode === 'gmail-draft'
            ? 'Invite drafted in your Gmail — review and send.'
            : 'No invite email configured; share the link yourself.'
      toast.success(`${result.provisioned ? 'Invited' : 'Added'} to project. ${emailNote}`)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to invite')
    },
  })

  const changeRole = useMutation({
    mutationFn: ({ grantId, role }: { grantId: string; role: string }) =>
      fetchJSON(`/api/acls/${grantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to change role'),
  })

  const removeGrant = useMutation({
    mutationFn: (grantId: string) => fetchJSON(`/api/acls/${grantId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove member'),
  })

  const setVisibility = useMutation({
    mutationFn: (v: 'tenant' | 'restricted') =>
      fetchJSON(`/api/acls/visibility/project/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility: v }),
      }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to change visibility'),
  })

  const memberLabel = (grant: AclGrant): string => {
    if (grant.principalType === 'team') return `Team ${grant.principalId.slice(0, 8)}`
    const user = users?.find((u) => u.id === grant.principalId)
    return user ? user.displayName?.trim() || user.email : grant.principalId.slice(0, 8)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm">Restricted access</p>
          <p className="text-xs text-muted-foreground">
            {visibility === 'restricted'
              ? 'Only the members below (and their tasks inside this project) can see it.'
              : 'Everyone in this workspace can see this project.'}
          </p>
        </div>
        <Switch
          checked={visibility === 'restricted'}
          onCheckedChange={(checked) => setVisibility.mutate(checked ? 'restricted' : 'tenant')}
          disabled={setVisibility.isPending}
        />
      </div>

      {/* Member list */}
      <div className="space-y-1.5">
        {(grants ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground italic">No explicit members yet.</p>
        )}
        {(grants ?? []).map((grant) => (
          <div key={grant.id} className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm">{memberLabel(grant)}</span>
            <Select
              value={grant.role}
              onValueChange={(role) => {
                if (role) changeRole.mutate({ grantId: grant.id, role })
              }}
            >
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => removeGrant.mutate(grant.id)}
              title="Remove member"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} />
            </Button>
          </div>
        ))}
      </div>

      {/* Invite form */}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (inviteEmail.trim()) invite.mutate()
        }}
      >
        <Input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="email@company.com"
          className="h-8 flex-1 text-sm"
        />
        <Select
          value={inviteRole}
          onValueChange={(v) => {
            if (v) setInviteRole(v as typeof inviteRole)
          }}
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={!inviteEmail.trim() || invite.isPending}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>
    </div>
  )
}
