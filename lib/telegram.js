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

// Убирает "часики" на кнопке после того, как её нажали
export async function answerCallbackQuery(callbackQueryId, text = '') {
  const res = await fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('answerCallbackQuery failed', res.status, body);
  }
  return res;
}

// Обновляет уже отправленное сообщение "на месте" (для кнопки "Обновить статус")
export async function editMessageText(chatId, messageId, text, extra = {}) {
  const res = await fetch(`${TG_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('editMessageText failed', res.status, body);
  }
  return res;
}
