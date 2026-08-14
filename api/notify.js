import { getAuth } from 'firebase-admin/auth';
import { getDb } from '../lib/firebase.js';
import { sendMessage } from '../lib/telegram.js';

// ADMIN_EMAIL должен совпадать с тем, что в firebase-config.js основного сайта
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'wbtipoofficialcom@gmail.com';

// Вызывается из admin/orders.html после смены статуса заказа.
// Тело запроса: { uid: string, text: string }
// Авторизация — тем же Firebase ID-токеном, которым админ уже вошёл в /admin
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).send('unauthorized');

  try {
    getDb(); // гарантирует, что initializeApp уже вызван до getAuth()
    const decoded = await getAuth().verifyIdToken(idToken);
    const isAdmin = decoded.email === ADMIN_EMAIL || decoded.admin === true;
    if (!isAdmin) return res.status(403).send('forbidden');
  } catch (e) {
    return res.status(401).send('unauthorized');
  }

  const { uid, text } = req.body || {};
  if (!uid || !text) return res.status(400).send('uid и text обязательны');

  try {
    const db = getDb();
    const userSnap = await db.collection('users').doc(uid).get();
    const tgChatId = userSnap.exists ? userSnap.data().tgChatId : null;

    if (!tgChatId) {
      // Юзер не привязал телеграм — это ожидаемо, не ошибка
      return res.status(200).json({ sent: false, reason: 'not_linked' });
    }

    await sendMessage(tgChatId, text);
    res.status(200).json({ sent: true });
  } catch (e) {
    console.error('notify error', e);
    res.status(500).send('internal error');
  }
}
