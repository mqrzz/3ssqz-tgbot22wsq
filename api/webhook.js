import { getDb } from '../lib/firebase.js';
import { sendMessage } from '../lib/telegram.js';
import { mintIdToken } from '../lib/mintIdToken.js';

// Должно 1-в-1 совпадать со списком в admin/orders.html (S = [...])
const STATUS_LABELS = ['Новая заявка', 'Обсуждение', 'В работе', 'На проверке', 'Правки', 'Готово', 'Ожидает доплаты'];
function statusLabel(st) {
  if (st === -1) return 'Ожидает оплаты';
  return STATUS_LABELS[st ?? 0] ?? '—';
}

const CABINET_ORDERS_URL = 'https://antviz.ru/profile/orders.html';
const CREATE_PAYMENT_URL = 'https://api-lac-six-78.vercel.app/api/createPayment';

// Только этот chat_id (твой личный, в Telegram) может слать /broadcast.
// Как узнать свой chat_id — см. README, раздел "Рассылка".
const ADMIN_TG_CHAT_ID = process.env.ADMIN_TG_CHAT_ID ? Number(process.env.ADMIN_TG_CHAT_ID) : null;

function appButton(text = '📋 Открыть заказы в приложении') {
  return { inline_keyboard: [[{ text, web_app: { url: CABINET_ORDERS_URL } }]] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

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
          'Команды: /status — статус заказов, /help — все команды.\n' +
          'Можно просто написать сообщение сюда — оно попадёт в поддержку.'
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

    if (text === '/help') {
      await sendMessage(chatId,
        'Команды:\n/status — статус ваших заказов\n/help — этот список\n\n' +
        'Просто напишите сообщение — оно уйдёт в поддержку, и вам ответят там же в кабинете.'
      );
      return res.status(200).send('ok');
    }

    if (text.startsWith('/broadcast')) {
      await handleBroadcast(db, chatId, text, res);
      return;
    }

    // Любой другой текст — не команда, значит это обращение в поддержку
    await handleTicketFromText(db, chatId, text, msg.from, res);
  } catch (e) {
    console.error('webhook error', e);
    res.status(200).send('ok'); // Telegram ретраит при не-200, поэтому всегда отвечаем 200
  }
}

async function findUidByChat(db, chatId) {
  const snap = await db.collection('users').where('tgChatId', '==', chatId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
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
    '✅ Аккаунт привязан. Теперь сюда будут приходить уведомления по заказу, можно спросить /status, а обычные сообщения сюда попадут в поддержку.',
    { reply_markup: appButton() }
  );
  res.status(200).send('ok');
}

async function handleStatus(db, chatId, res) {
  const uid = await findUidByChat(db, chatId);
  if (!uid) {
    await sendMessage(chatId, 'Аккаунт не привязан. Зайдите в личный кабинет → Настройки → «Привязать Telegram».');
    return res.status(200).send('ok');
  }

  const ordersSnap = await db.collection('orders')
    .where('uid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();

  if (ordersSnap.empty) {
    await sendMessage(chatId, 'Заказов пока нет.', { reply_markup: appButton('🚀 Открыть кабинет') });
    return res.status(200).send('ok');
  }

  // Для заказов, ожидающих оплату/доплату, готовим отдельную ссылку на оплату
  let idToken = null;
  const rows = [];
  const lines = [];

  for (const d of ordersSnap.docs) {
    const o = d.data();
    const num = d.id.slice(0, 7).toUpperCase();
    lines.push(`№${num} — ${o.package || o.siteType || 'заказ'}\nСтатус: <b>${statusLabel(o.status)}</b>`);

    const needsPay = o.status === -1 || o.status === 6;
    if (needsPay) {
      try {
        if (!idToken) idToken = await mintIdToken(uid);
        const r = await fetch(CREATE_PAYMENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
          body: JSON.stringify({ orderId: d.id, type: o.status === 6 ? 'partial' : 'order' })
        });
        const pd = await r.json();
        if (pd.paymentUrl) {
          rows.push([{ text: `💳 Оплатить №${num}`, url: pd.paymentUrl }]);
        }
      } catch (e) {
        console.error('createPayment failed for', d.id, e);
      }
    }
  }

  rows.push([{ text: '📋 Открыть заказы в приложении', web_app: { url: CABINET_ORDERS_URL } }]);
  await sendMessage(chatId, lines.join('\n\n'), { reply_markup: { inline_keyboard: rows } });
  res.status(200).send('ok');
}

async function handleTicketFromText(db, chatId, text, from, res) {
  const uid = await findUidByChat(db, chatId);
  if (!uid) {
    await sendMessage(chatId, 'Аккаунт не привязан — напишите через сайт, либо привяжите Telegram в личном кабинете → Настройки.');
    return res.status(200).send('ok');
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : {};

  await db.collection('service_tickets').add({
    title: 'Обращение из Telegram',
    description: text,
    images: null,
    uid,
    userName: u.displayName || from?.first_name || 'Пользователь',
    userEmail: u.email || '',
    orderId: '', orderSiteType: '', orderTariff: '', orderDomain: '', // не привязано к конкретному сайту — заявка общая
    billing: 'telegram',
    status: 'open',
    createdAt: new Date()
  });

  await sendMessage(chatId, '✅ Сообщение отправлено в поддержку. Ответ придёт сюда и будет виден в кабинете → Обслуживание.');
  res.status(200).send('ok');
}

async function handleBroadcast(db, chatId, text, res) {
  if (!ADMIN_TG_CHAT_ID || chatId !== ADMIN_TG_CHAT_ID) {
    return res.status(200).send('ok'); // молча игнорируем чужие попытки
  }
  const body = text.replace('/broadcast', '').trim();
  if (!body) {
    await sendMessage(chatId, 'Использование: /broadcast текст сообщения всем привязанным клиентам');
    return res.status(200).send('ok');
  }

  const usersSnap = await db.collection('users').where('tgChatId', '!=', null).get();
  let sent = 0;
  for (const doc of usersSnap.docs) {
    const cid = doc.data().tgChatId;
    if (!cid) continue;
    try { await sendMessage(cid, body); sent++; } catch (e) { console.error('broadcast fail', doc.id, e); }
  }
  await sendMessage(chatId, `Готово, отправлено: ${sent}`);
  res.status(200).send('ok');
}
