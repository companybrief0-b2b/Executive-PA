'use client'

import { useState } from 'react'
import Link from 'next/link'

/** Breadcrumb plus the brief-level actions (email it, open the full reference). */
export default function BriefToolbar({
  briefId, weekOf, generatedAt,
}: {
  briefId: string
  weekOf: string
  generatedAt?: string | null
}) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState('')

  async function sendBrief() {
    setSending(true)
    setSendError('')
    try {
      const res = await fetch(`/api/briefs/${briefId}/send`, { method: 'POST' })
      if (res.ok) {
        setSent(true)
        setTimeout(() => setSent(false), 4000)
      } else {
        const d = await res.json().catch(() => ({}))
        setSendError(d.error ?? 'Failed to send')
      }
    } catch {
      setSendError('Failed to send')
    }
    setSending(false)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
        <Link href="/briefs" className="hover:text-gray-700 dark:hover:text-gray-300 transition-colors">Intelligence Briefs</Link>
        <span>/</span>
        <span className="text-gray-600 dark:text-gray-300">Week of {weekOf}</span>
        {generatedAt && (
          <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500">
            · Generated {new Date(generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={sendBrief}
          disabled={sending || sent}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-gray-300 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {sent ? 'Sent ✓' : sending ? 'Sending…' : 'Email brief'}
        </button>
        {sendError && <span className="text-xs text-red-600">{sendError}</span>}
        <Link
          href={`/briefs/${briefId}/full`}
          className="text-xs font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-300 px-3 py-1.5 rounded-lg transition-colors"
        >
          All intelligence →
        </Link>
      </div>
    </div>
  )
}
