import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { fetchJSON } from '@/lib/api'

/**
 * One-shot export/import of tasks + projects between Fulcrum instances
 * (e.g. desktop ↔ SaaS). Execution-plane state (worktrees, repos,
 * terminals) intentionally does not travel.
 */
export function InstanceTransfer() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const handleExport = () => {
    // Plain navigation so the browser handles the attachment download.
    window.open('/api/transfer/export', '_blank')
  }

  const handleImportFile = async (file: File) => {
    setImporting(true)
    try {
      const bundle = JSON.parse(await file.text())
      const result = await fetchJSON<{ imported: { projects: number; tasks: number } }>(
        '/api/transfer/import',
        { method: 'POST', body: JSON.stringify(bundle) }
      )
      toast.success(
        `Imported ${result.imported.tasks} tasks and ${result.imported.projects} projects.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">Instance transfer</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Move tasks and projects between Fulcrum instances (desktop ↔ cloud) as a JSON
          bundle. Worktrees and terminals stay on this machine.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleImportFile(file)
          }}
        />
        <Button variant="outline" size="sm" onClick={handleExport}>
          Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          {importing ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </div>
  )
}
