import { getDb } from '../lib/firebase.js';
import { sendMessage } from '../lib/telegram.js';

// Должно 1-в-1 совпадать со списком в admin/orders.html (S = [...])
const STATUS_LABELS = ['Новая заявка', 'Обсуждение', 'В работе', 'На проверке', 'Правки', 'Готово', 'Ожидает доплаты'];
function statusLabel(st) {
  if (st === -1) return 'Ожидает оплаты';
  return STATUS_LABELS[st ?? 0] ?? '—';
}

// Ссылка на кабинет — если структура путей поменяется, поправить здесь и всё.
const CABINET_ORDERS_URL = 'https://antviz.ru/profile/orders.html';

// Кнопка "Открыть приложение", которую можно приклеить к любому сообщению.
// web_app-кнопки открывают сайт внутри Telegram (Mini App) — регистрировать
// через BotFather для этого не нужно, достаточно HTTPS-ссылки.
function appButton(text = '📋 Открыть заказы в приложении') {
  return { inline_keyboard: [[{ text, web_app: { url: CABINET_ORDERS_URL } }]] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  // Секрет, который Telegram присылает в заголовке — задаётся при setWebhook (см. README)
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const update = req.body;
  const msg = update?.message;
  if (!msg || !msg.text) return res.status(200).send('ok');

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const db = getDb();

  try {
    if (text.startsWith('/start')) {
      const token = text.split(' ')[1];
      if (!token) {
        await sendMessage(chatId,
          'Привет! Это бот Antviz — сюда приходят уведомления по вашим заказам и статус.\n\n' +
          'Чтобы привязать аккаунт, зайдите в личный кабинет → Настройки → «Привязать Telegram».\n\n' +
          'Команды: /status — статус заказов, /app — открыть кабинет, /help — все команды.'
        );
        return res.status(200).send('ok');
      }
      await handleLink(db, chatId, token, msg.from?.username || null, res);
      return;
    }

    if (text === '/status') {
      await handleStatus(db, chatId, res);
      return;
    }

    if (text === '/app') {
      await sendMessage(chatId, 'Открыть кабинет:', { reply_markup: appButton('🚀 Войти в приложение') });
      return res.status(200).send('ok');
    }

    if (text === '/help') {
      await sendMessage(chatId,
        'Команды:\n/status — статус ваших заказов\n/app — открыть кабинет в приложении\n/help — этот список'
      );
      return res.status(200).send('ok');
    }

    await sendMessage(chatId, 'Не понял команду. Список команд — /help');
    res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    res.status(200).send('ok'); // Telegram ретраит при не-200, поэтому всегда отвечаем 200
  }
}

async function handleLink(db, chatId, token, username, res) {
  const tokenRef = db.collection('linkTokens').doc(token);
  const tokenSnap = await tokenRef.get();

  if (!tokenSnap.exists) {
    await sendMessage(chatId, 'Ссылка недействительна или уже использована. Откройте привязку заново в личном кабинете.');
    return res.status(200).send('ok');
  }
  const data = tokenSnap.data();
  if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
    await tokenRef.delete();
    await sendMessage(chatId, 'Ссылка истекла (действует 15 минут). Откройте привязку заново в личном кабинете.');
    return res.status(200).send('ok');
  }

  await db.collection('users').doc(data.uid).set(
    { tgChatId: chatId, tgUsername: username, tgLinkedAt: new Date() },
    { merge: true }
  );
  await tokenRef.delete();

  await sendMessage(chatId,
    '✅ Аккаунт привязан. Теперь сюда будут приходить уведомления по заказу, и можно спросить /status в любой момент.',
    { reply_markup: appButton() }
  );
  res.status(200).send('ok');
}

async function handleStatus(db, chatId, res) {
  const usersSnap = await db.collection('users').where('tgChatId', '==', chatId).limit(1).get();
  if (usersSnap.empty) {
    await sendMessage(chatId, 'Аккаунт не привязан. Зайдите в личный кабинет → Настройки → «Привязать Telegram».');
    return res.status(200).send('ok');
  }
  const uid = usersSnap.docs[0].id;

  const ordersSnap = await db.collection('orders')
    .where('uid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();

  if (ordersSnap.empty) {
    await sendMessage(chatId, 'Заказов пока нет.', { reply_markup: appButton('🚀 Открыть кабинет') });
    return res.status(200).send('ok');
  }

  const lines = ordersSnap.docs.map(d => {
    const o = d.data();
    const num = d.id.slice(0, 7).toUpperCase();
    return `№${num} — ${o.package || o.siteType || 'заказ'}\nСтатус: <b>${statusLabel(o.status)}</b>`;
  });

  await sendMessage(chatId, lines.join('\n\n'), { reply_markup: appButton() });
  res.status(200).send('ok');
}
