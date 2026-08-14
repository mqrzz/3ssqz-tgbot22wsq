import { getDb } from '../lib/firebase.js';
import { sendMessage, answerCallbackQuery, editMessageText } from '../lib/telegram.js';
import { mintIdToken } from '../lib/mintIdToken.js';

// Должно 1-в-1 совпадать со списком в admin/orders.html (S = [...])
const STATUS_LABELS = ['Новая заявка', 'Обсуждение', 'В работе', 'На проверке', 'Правки', 'Готово', 'Ожидает доплаты'];
function statusLabel(st) {
  if (st === -1) return 'Ожидает оплаты';
  return STATUS_LABELS[st ?? 0] ?? '—';
}

const CABINET_ORDERS_URL = 'https://antviz.ru/profile/orders.html';
const TICKETS_URL = 'https://antviz.ru/profile/tickets.html'; // там же выбор тарифа обслуживания
const CREATE_PAYMENT_URL = 'https://api-lac-six-78.vercel.app/api/createPayment';

// Твой юзернейм в Telegram (без @) — только с этого аккаунта работают рассылки.
const ADMIN_TG_USERNAME = (process.env.ADMIN_TG_USERNAME || 'antviz_official').toLowerCase();

const AWAIT_TIMEOUT_MIN = 10;

// ===== Клавиатуры =====

// Постоянная клавиатура внизу экрана (замена системной) — 3 главных действия
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 Мои заказы' }, { text: '✉️ Поддержка' }],
    [{ text: '⚙️ Обслуживание' }]
  ],
  resize_keyboard: true
};

function appButton(text = '📋 Открыть заказы в приложении') {
  return { inline_keyboard: [[{ text, web_app: { url: CABINET_ORDERS_URL } }]] };
}
function supportButton() {
  return { inline_keyboard: [[{ text: '✉️ Написать в поддержку', callback_data: 'start_ticket' }]] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const update = req.body;
  const db = getDb();

  try {
    if (update.callback_query) {
      await handleCallback(db, update.callback_query, res);
      return;
    }

    const msg = update?.message;
    if (!msg || !msg.text) return res.status(200).send('ok');

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const isAdmin = (msg.from?.username || '').toLowerCase() === ADMIN_TG_USERNAME;

    if (text.startsWith('/start')) {
      const token = text.split(' ')[1];
      if (!token) {
        await sendMessage(chatId,
          'Привет! Это бот Antviz — сюда приходят уведомления по вашим заказам и статус.\n\n' +
          'Чтобы привязать аккаунт, зайдите в личный кабинет → Настройки → «Привязать Telegram».',
          { reply_markup: MAIN_KEYBOARD }
        );
        return res.status(200).send('ok');
      }
      await handleLink(db, chatId, token, msg.from?.username || null, res);
      return;
    }

    if (text === '/status' || text === '📋 Мои заказы') { await handleStatus(db, chatId, null, res); return; }

    if (text === '/ticket' || text === '✉️ Поддержка') { await startTicket(db, chatId, res); return; }

    if (text === '⚙️ Обслуживание') {
      await sendMessage(chatId,
        'Подключить или продлить обслуживание — выбор тарифа и оплата в кабинете:',
        { reply_markup: { inline_keyboard: [[{ text: '⚙️ Открыть обслуживание', web_app: { url: TICKETS_URL } }]] } }
      );
      return res.status(200).send('ok');
    }

    if (text === '/help') {
      await sendMessage(chatId,
        'Команды:\n/status — статус ваших заказов\n/ticket — написать в поддержку\n/help — этот список\n\n' +
        'Или пользуйтесь кнопками внизу экрана.',
        { reply_markup: supportButton() }
      );
      return res.status(200).send('ok');
    }

    if (text.startsWith('/broadcast') && isAdmin) {
      const body = text.replace('/broadcast', '').trim();
      if (body) { await confirmBroadcast(db, chatId, body, res); return; }
    }

    await handlePlainText(db, chatId, text, msg.from, isAdmin, res);
  } catch (e) {
    console.error('webhook error', e);
    res.status(200).send('ok'); // Telegram ретраит при не-200, поэтому всегда отвечаем 200
  }
}

async function findUidByChat(db, chatId) {
  const snap = await db.collection('users').where('tgChatId', '==', chatId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

function stateRef(db, chatId) { return db.collection('botState').doc(String(chatId)); }
async function clearState(db, chatId) { await stateRef(db, chatId).delete().catch(() => {}); }
async function getState(db, chatId) {
  const snap = await stateRef(db, chatId).get();
  if (!snap.exists) return null;
  const s = snap.data();
  if (s.expiresAt && s.expiresAt.toDate() < new Date()) { await clearState(db, chatId); return null; }
  return s;
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
    '✅ Аккаунт привязан. Пользуйтесь кнопками внизу экрана — заказы, поддержка, обслуживание.',
    { reply_markup: MAIN_KEYBOARD }
  );
  res.status(200).send('ok');
}

// ===== Статус заказов (используется и как обычное сообщение, и при "Обновить") =====

async function buildStatusView(db, uid) {
  const ordersSnap = await db.collection('orders')
    .where('uid', '==', uid).orderBy('createdAt', 'desc').limit(5).get();

  if (ordersSnap.empty) {
    return { text: 'Заказов пока нет.', reply_markup: appButton('🚀 Открыть кабинет') };
  }

  let idToken = null;
  const rows = [];
  const lines = [];

  for (const d of ordersSnap.docs) {
    const o = d.data();
    const num = d.id.slice(0, 7).toUpperCase();
    lines.push(`№${num} — ${o.package || o.siteType || 'заказ'}\nСтатус: <b>${statusLabel(o.status)}</b>`);

    const btnRow = [];
    if (o.status === -1 || o.status === 6) {
      try {
        if (!idToken) idToken = await mintIdToken(uid);
        const r = await fetch(CREATE_PAYMENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
          body: JSON.stringify({ orderId: d.id, type: o.status === 6 ? 'partial' : 'order' })
        });
        const pd = await r.json();
        if (pd.paymentUrl) btnRow.push({ text: `💳 Оплатить №${num}`, url: pd.paymentUrl });
      } catch (e) { console.error('createPayment failed for', d.id, e); }
    }
    if (Array.isArray(o.statusHistory) && o.statusHistory.length) {
      btnRow.push({ text: `📜 История №${num}`, callback_data: `history:${d.id}` });
    }
    if (o.status === 5) {
      btnRow.push({ text: `⭐ Отзыв №${num}`, web_app: { url: CABINET_ORDERS_URL } });
    }
    if (btnRow.length) rows.push(btnRow);
  }

  rows.push([{ text: '🔄 Обновить', callback_data: 'refresh_status' }]);
  rows.push([{ text: '📋 Открыть заказы в приложении', web_app: { url: CABINET_ORDERS_URL } }]);

  return { text: lines.join('\n\n'), reply_markup: { inline_keyboard: rows } };
}

async function handleStatus(db, chatId, editMessageId, res) {
  const uid = await findUidByChat(db, chatId);
  if (!uid) {
    await sendMessage(chatId, 'Аккаунт не привязан. Зайдите в личный кабинет → Настройки → «Привязать Telegram».');
    return res.status(200).send('ok');
  }
  const view = await buildStatusView(db, uid);
  if (editMessageId) {
    await editMessageText(chatId, editMessageId, view.text, { reply_markup: view.reply_markup });
  } else {
    await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
  }
  res.status(200).send('ok');
}

// ===== Тикет в поддержку — явный флоу =====

async function startTicket(db, chatId, res) {
  const uid = await findUidByChat(db, chatId);
  if (!uid) {
    await sendMessage(chatId, 'Сначала привяжите аккаунт: личный кабинет → Настройки → «Привязать Telegram».');
    return res.status(200).send('ok');
  }
  await stateRef(db, chatId).set({
    type: 'ticket', uid,
    expiresAt: new Date(Date.now() + AWAIT_TIMEOUT_MIN * 60 * 1000)
  });
  await sendMessage(chatId, '✍️ Опишите проблему одним сообщением — оно уйдёт в поддержку и появится в кабинете.\n\nТакже можно написать напрямую: @antviz_official');
  res.status(200).send('ok');
}

async function submitTicket(db, chatId, uid, text, from, res) {
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : {};

  await db.collection('service_tickets').add({
    title: 'Обращение из Telegram',
    description: text,
    images: null,
    uid,
    userName: u.displayName || from?.first_name || 'Пользователь',
    userEmail: u.email || '',
    orderId: '', orderSiteType: '', orderTariff: '', orderDomain: '',
    billing: 'telegram',
    status: 'open',
    createdAt: new Date()
  });

  await clearState(db, chatId);
  await sendMessage(chatId, '✅ Тикет создан. Ответ придёт сюда и будет виден в кабинете → Обслуживание.');
  res.status(200).send('ok');
}

// ===== Рассылка (только с аккаунта ADMIN_TG_USERNAME) =====

async function confirmBroadcast(db, chatId, text, res) {
  await stateRef(db, chatId).set({
    type: 'broadcast', text,
    expiresAt: new Date(Date.now() + AWAIT_TIMEOUT_MIN * 60 * 1000)
  });
  await sendMessage(chatId,
    `Отправить всем привязанным клиентам:\n\n«${text}»`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Да, отправить', callback_data: 'bcast_yes' },
      { text: '✖️ Отмена', callback_data: 'bcast_no' }
    ]] } }
  );
  res.status(200).send('ok');
}

async function runBroadcast(db, chatId, text) {
  const usersSnap = await db.collection('users').where('tgChatId', '!=', null).get();
  let sent = 0;
  for (const doc of usersSnap.docs) {
    const cid = doc.data().tgChatId;
    if (!cid) continue;
    try { await sendMessage(cid, text); sent++; } catch (e) { console.error('broadcast fail', doc.id, e); }
  }
  await sendMessage(chatId, `Готово, отправлено: ${sent}`);
}

// ===== Роутинг обычного текста =====

async function handlePlainText(db, chatId, text, from, isAdmin, res) {
  const state = await getState(db, chatId);

  if (state?.type === 'ticket') {
    await submitTicket(db, chatId, state.uid, text, from, res);
    return;
  }

  if (isAdmin) {
    await confirmBroadcast(db, chatId, text, res);
    return;
  }

  await sendMessage(chatId,
    'Чтобы написать в поддержку — нажмите кнопку ниже, отправьте /ticket, или используйте кнопки внизу экрана.',
    { reply_markup: supportButton() }
  );
  res.status(200).send('ok');
}

// ===== Callback-кнопки =====

async function handleCallback(db, cq, res) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data;

  if (data === 'start_ticket') {
    await answerCallbackQuery(cq.id);
    await startTicket(db, chatId, res);
    return;
  }

  if (data === 'refresh_status') {
    await answerCallbackQuery(cq.id, 'Обновлено');
    await handleStatus(db, chatId, messageId, res);
    return;
  }

  if (data.startsWith('history:')) {
    const orderId = data.slice('history:'.length);
    await answerCallbackQuery(cq.id);
    const snap = await db.collection('orders').doc(orderId).get();
    if (!snap.exists) { await sendMessage(chatId, 'Заказ не найден.'); return res.status(200).send('ok'); }
    const o = snap.data();
    const num = orderId.slice(0, 7).toUpperCase();
    const hist = (o.statusHistory || [])
      .map(h => `${statusLabel(h.status)} — ${h.at?.toDate ? h.at.toDate().toLocaleString('ru-RU') : ''}`)
      .join('\n');
    await sendMessage(chatId, `История заказа №${num}:\n\n${hist || 'Пока пусто.'}`);
    res.status(200).send('ok');
    return;
  }

  if (data === 'bcast_yes' || data === 'bcast_no') {
    const state = await getState(db, chatId);
    await answerCallbackQuery(cq.id, data === 'bcast_yes' ? 'Отправляю…' : 'Отменено');
    if (state?.type === 'broadcast') {
      await clearState(db, chatId);
      if (data === 'bcast_yes') await runBroadcast(db, chatId, state.text);
      else await sendMessage(chatId, 'Отменено, никому не отправлено.');
    }
    res.status(200).send('ok');
    return;
  }

  await answerCallbackQuery(cq.id);
  res.status(200).send('ok');
}
