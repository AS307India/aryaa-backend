import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

let isFcmInitialized = false;

try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
    }
    isFcmInitialized = true;
  } else {
    console.warn('[FCM_INIT] Firebase Admin NOT initialized: missing environment variables');
  }
} catch (error: any) {
  console.error('[FCM_INIT] Firebase Admin initialization failed:', error.message);
}

console.log('[FCM_INIT] getApps().length:', getApps().length);
console.log('[FCM_INIT] isFcmInitialized:', isFcmInitialized);
console.log('[FCM_INIT] project_id set:', !!process.env.FIREBASE_PROJECT_ID);
console.log('[FCM_INIT] client_email set:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('[FCM_INIT] private_key set:', !!process.env.FIREBASE_PRIVATE_KEY);
console.log('[FCM_INIT] private_key length:', process.env.FIREBASE_PRIVATE_KEY?.length || 0);

function buildLocationString(lat: number | null, lng: number | null, w3wAddress: string | null): string {
  if (w3wAddress) return `///${w3wAddress} (${lat}, ${lng})`;
  if (lat !== null && lng !== null) return `Location: ${lat}, ${lng}`;
  return "Location unavailable";
}

export async function sendSosPush(
  fcmToken: string,
  userName: string,
  userPhone: string,
  lat: number | null,
  lng: number | null,
  w3wAddress: string | null,
  sosEventId: string,
  accuracy: number | null
): Promise<boolean> {
  console.log('[FCM_SEND] entering sendSosPush for token:', fcmToken?.substring(0, 20) + '...');
  
  if (!isFcmInitialized) {
    console.warn('[FCM_SEND] Firebase Admin not initialized, skipping push');
    return false;
  }

  try {
    const timeZone = 'Asia/Kolkata';
    const formattedTime = new Date().toLocaleTimeString('en-IN', { timeZone });

    const message = {
      token: fcmToken,
      notification: {
        title: `🆘 ${userName} needs help!`,
        body: `${buildLocationString(lat, lng, w3wAddress)} at ${formattedTime} IST`
      },
      data: {
        sosEventId: sosEventId,
        type: 'SOS_ALERT',
        userName: userName,
        userPhone: userPhone || '',
        latitude: lat?.toString() ?? '',
        longitude: lng?.toString() ?? '',
        w3wAddress: w3wAddress ?? '',
        triggeredAt: new Date().toISOString(),
        accuracy: accuracy?.toString() ?? ''
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'aryaa_sos_incoming_v2',
          color: '#EF4444', // Crimson
          sound: 'aryaa_emergency_alert',
          defaultVibrateTimings: false,
          defaultLightSettings: false
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

export async function sendSosCancelPush(
  fcmToken: string,
  sosEventId: string
): Promise<boolean> {
  console.log('[FCM_CANCEL] entering sendSosCancelPush for token:', fcmToken?.substring(0, 20) + '...');

  if (!isFcmInitialized) {
    console.warn('[FCM_CANCEL] Firebase Admin not initialized, skipping push');
    return false;
  }

  try {
    const message = {
      token: fcmToken,
      data: {
        sosEventId: sosEventId,
        type: 'SOS_CANCEL'
      },
      android: {
        priority: 'high' as const
      }
    };

    console.log('[FCM_CANCEL] calling getMessaging().send()');
    const response = await getMessaging().send(message);
    console.log('[FCM_CANCEL] send success, messageId:', response);
    return true;
  } catch (error: any) {
    console.error('[FCM_CANCEL] send failed:', error.message, error.code);
    return false;
  }
}

export async function sendDuressAlertPush(
  fcmToken: string,
  userName: string,
  userPhone: string,
  lat: number | null,
  lng: number | null,
  w3wAddress: string | null,
  sosEventId: string,
  accuracy: number | null
): Promise<boolean> {
  console.log('[FCM_DURESS] entering sendDuressAlertPush for token:', fcmToken?.substring(0, 20) + '...');

  if (!isFcmInitialized) {
    console.warn('[FCM_DURESS] Firebase Admin not initialized, skipping push');
    return false;
  }

  try {
    const timeZone = 'Asia/Kolkata';
    const formattedTime = new Date().toLocaleTimeString('en-IN', { timeZone });

    const message = {
      token: fcmToken,
      notification: {
        title: `⚠️ Silent Alert from ${userName}`,
        body: `${userName} cancelled their SOS, but this may not be voluntary. Their location is still being tracked. Please check on them discreetly.`
      },
      data: {
        sosEventId: sosEventId,
        type: 'DURESS_ALERT',
        userName: userName,
        userPhone: userPhone || '',
        latitude: lat?.toString() ?? '',
        longitude: lng?.toString() ?? '',
        w3wAddress: w3wAddress ?? '',
        triggeredAt: new Date().toISOString(),
        accuracy: accuracy?.toString() ?? ''
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'aryaa_duress_alert',
          defaultSound: true,
          defaultVibrateTimings: true,
          defaultLightSettings: true
        }
      }
    };

    console.log('[FCM_DURESS] calling getMessaging().send()');
    const response = await getMessaging().send(message);
    console.log('[FCM_DURESS] send success, messageId:', response);
    return true;
  } catch (error: any) {
    console.error('[FCM_DURESS] send failed:', error.message, error.code);
    return false;
  }
}

export async function sendDeadZoneAlertPush(
  fcmToken: string,
  userName: string,
  userPhone: string,
  lat: number | null,
  lng: number | null,
  w3wAddress: string | null,
  checkInId: string,
  accuracy: number | null
): Promise<boolean> {
  console.log('[FCM_DEADZONE] entering sendDeadZoneAlertPush for token:', fcmToken?.substring(0, 20) + '...');

  if (!isFcmInitialized) {
    console.warn('[FCM_DEADZONE] Firebase Admin not initialized, skipping push');
    return false;
  }

  try {
    const locationPart = (lat !== null && lng !== null)
      ? (w3wAddress ? `///${w3wAddress} (${lat}, ${lng})` : `${lat}, ${lng}`)
      : 'unavailable';

    const message = {
      token: fcmToken,
      notification: {
        title: `⚠️ ${userName} may need help`,
        body: `${userName} entered a no-signal area and hasn't checked in as expected. Last known location: ${locationPart}. This may be nothing, but please check on them.`
      },
      data: {
        checkInId: checkInId,
        type: 'DEADZONE_ALERT',
        userName: userName,
        userPhone: userPhone || '',
        latitude: lat?.toString() ?? '',
        longitude: lng?.toString() ?? '',
        w3wAddress: w3wAddress ?? '',
        triggeredAt: new Date().toISOString(),
        accuracy: accuracy?.toString() ?? ''
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'aryaa_duress_alert', // use standard default alert channel
          defaultSound: true,
          defaultVibrateTimings: true,
          defaultLightSettings: true
        }
      }
    };

    console.log('[FCM_DEADZONE] calling getMessaging().send()');
    const response = await getMessaging().send(message);
    console.log('[FCM_DEADZONE] send success, messageId:', response);
    return true;
  } catch (error: any) {
    console.error('[FCM_DEADZONE] send failed:', error.message, error.code);
    return false;
  }
}


