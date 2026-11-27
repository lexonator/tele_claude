// Общее для роутера и клиента.
export type Msg = Record<string, any>

// "yes abcde" / "no abcde" — ответ на запрос разрешения (5 букв a-z без 'l').
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// .jpg/.png/... уходят как фото, остальное как документы.
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

// Telegram режет сообщения на 4096 символов.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// Короткое описание вызова инструмента для строки статуса в Telegram.
export function describeTool(t: string, ti: Record<string, any> = {}): string | null {
  if (t.startsWith('mcp__tele__')) return null // свои ответы в статусе не показываем
  const short = (x: unknown, n = 70) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const base = (x: unknown) => String(x ?? '').split('/').pop()
  return (
    t === 'Bash' ? `⚙️ Команда: ${short(ti.description || ti.command)}` :
    t === 'Read' ? `📖 Читаю ${base(ti.file_path)}` :
    t === 'Edit' || t === 'MultiEdit' ? `✏️ Правлю ${base(ti.file_path)}` :
    t === 'Write' ? `📝 Пишу ${base(ti.file_path)}` :
    t === 'Grep' ? `🔎 Ищу «${short(ti.pattern, 40)}»` :
    t === 'Glob' ? `🔎 Ищу файлы ${short(ti.pattern, 40)}` :
    t === 'WebSearch' ? `🌐 Ищу в сети: ${short(ti.query, 50)}` :
    t === 'WebFetch' ? `🌐 Открываю ${short(ti.url, 50)}` :
    t === 'Agent' || t === 'Task' ? `🤖 Подагент: ${short(ti.description, 50)}` :
    t === 'TodoWrite' ? '📋 Веду список задач' :
    `🔧 ${t.replace(/^mcp__/, '').replace(/__/g, ': ')}`
  )
}
