import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

console.log('[FCM_INIT] getApps().length:', getApps().length);
console.log('[FCM_INIT] project_id set:', !!process.env.FIREBASE_PROJECT_ID);
console.log('[FCM_INIT] client_email set:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('[FCM_INIT] private_key set:', !!process.env.FIREBASE_PRIVATE_KEY);
console.log('[FCM_INIT] private_key length:', process.env.FIREBASE_PRIVATE_KEY?.length || 0);

export async function sendSosPush(
  fcmToken: string,
  userName: string,
  userPhone: string,
  lat: number | null,
  lng: number | null,
  w3wAddress: string | null,
  sosEventId: string
): Promise<boolean> {
  console.log('[FCM_SEND] entering sendSosPush for token:', fcmToken?.substring(0, 20) + '...');
  const locationString = w3wAddress 
    ? w3wAddress 
    : (lat !== null && lng !== null ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : 'unavailable');

  try {
    const message = {
      token: fcmToken,
      notification: {
        title: `🆘 ${userName} needs help!`,
        body: `Emergency SOS via ARYAA. Location: ${locationString}`
      },
      data: {
        sosEventId: sosEventId,
        type: "SOS_ALERT",
        userName: userName,
        userPhone: userPhone,
        lat: lat !== null ? lat.toString() : "",
        lng: lng !== null ? lng.toString() : "",
        w3wAddress: w3wAddress || ""
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'aryaa_sos_incoming',
          color: '#EF4444', // Crimson
          sound: 'default'
        }
      }
    };

    console.log('[FCM_SEND] calling getMessaging().send()');
    const response = await getMessaging().send(message);
    console.log('[FCM_SEND] send success, messageId:', response);
    return true;
  } catch (error: any) {
    console.error('[FCM_SEND] send failed:', error.message, error.code);
    return false;
  }
}
