const TG_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function sendMessage(chatId, text, extra = {}) {
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Telegram sendMessage failed', res.status, body);
  }
  return res;
}
