import { getAuth } from 'firebase-admin/auth';
import { getDb } from './firebase.js';

// Firebase Web API Key — тот же, что в firebase-config.js основного сайта (публичный, не секрет)
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyBLGr2hpmnmj1Mxf9072m8vQXJkLUN6YyY';

// createPayment на бэкенде ЮКассы ждёт настоящий ID-токен пользователя в Authorization.
// У бота есть только uid — поэтому через Admin SDK делаем custom token и тут же
// меняем его на настоящий idToken тем же способом, каким это делает Firebase SDK в браузере.
export async function mintIdToken(uid) {
  getDb(); // гарантирует initializeApp()
  const customToken = await getAuth().createCustomToken(uid);

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  if (!res.ok) throw new Error('signInWithCustomToken failed: ' + (await res.text()));
  const data = await res.json();
  return data.idToken;
}
