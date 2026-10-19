let noticeTimer: ReturnType<typeof setTimeout> | undefined

export function sonaNotify(message: string, isError = false) {
  document.getElementById('sona-short-notice')?.remove()
  clearTimeout(noticeTimer)
  const notice = document.createElement('div')
  notice.id = 'sona-short-notice'
  notice.textContent = message
  notice.style.cssText = `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 18px;border:1px solid ${isError ? '#e84749' : '#c8aa6e'};background:#010a13;color:#f0e6d2;pointer-events:none`
  document.body.appendChild(notice)
  noticeTimer = setTimeout(() => notice.remove(), 1000)
}
