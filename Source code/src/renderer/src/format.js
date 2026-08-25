// The main process stores `lastVerified` as an ISO timestamp; formatting for
// display is the renderer's job (PLAN.md, "Data model").

function timeOf(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatLastVerified(iso) {
  if (!iso) return 'Never verified'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'Never verified'

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const dayDiff = Math.round((startOfToday - startOfThen) / 86400000)

  if (dayDiff <= 0) return `Today, ${timeOf(then)}`
  if (dayDiff === 1) return `Yesterday, ${timeOf(then)}`
  if (dayDiff < 7) return `${dayDiff} days ago`
  return then.toLocaleDateString()
}

export function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
