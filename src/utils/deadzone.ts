import { prisma } from '../db/index.js';
import { sendDeadZoneAlertPush } from './fcm.js';

export async function checkExpiredDeadZones(userId: string) {
  try {
    const now = new Date();
    console.log(`[DEADZONE_CHECK] checking for user: ${userId} now: ${now.toISOString()}`);

    const expiredCheckIn = await prisma.deadZoneCheckIn.findFirst({
      where: {
        userId,
        status: 'PENDING',
        gracePeriodEnd: {
          lt: now
        }
      }
    });

    console.log(`[DEADZONE_CHECK] found pending expired: ${expiredCheckIn ? 1 : 0}${expiredCheckIn ? ` (id: ${expiredCheckIn.id}, gracePeriodEnd: ${expiredCheckIn.gracePeriodEnd.toISOString()})` : ''}`);

    if (!expiredCheckIn) return;

    console.log(`[DEADZONE_MONITOR] Found expired check-in ${expiredCheckIn.id} for user ${userId}. Triggering alerts...`);

    // Transition to MISSED
    await prisma.deadZoneCheckIn.update({
      where: { id: expiredCheckIn.id },
      data: { status: 'MISSED' }
    });

    // Alert flow: fetch user and contacts
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { contacts: true }
    });

    if (!user) return;

    // Fetch contact registration FCM tokens
    const contactsWithFcm = await Promise.all(
      user.contacts.map(async (c) => {
        const contactUser = await prisma.user.findFirst({
          where: {
            phone: {
              equals: c.phone,
              mode: 'insensitive'
            }
          }
        });
        return {
          contact: c,
          fcmToken: contactUser?.fcmToken
        };
      })
    );

    // Dispatch FCM notifications in parallel, non-blocking
    await Promise.all(
      contactsWithFcm
        .filter(c => c.fcmToken)
        .map(async (c) => {
          try {
            await sendDeadZoneAlertPush(
              c.fcmToken!,
              user.name,
              user.phone,
              expiredCheckIn.lastLatitude,
              expiredCheckIn.lastLongitude,
              null, // w3wAddress is null by default for dead zone checkin
              expiredCheckIn.id,
              expiredCheckIn.lastAccuracy ? Math.round(expiredCheckIn.lastAccuracy) : null
            );
          } catch (err: any) {
            console.error(`[DEADZONE_MONITOR] Failed to send FCM to contact ${c.contact.id}:`, err.message);
          }
        })
    );

    // Transition to ALERTED
    await prisma.deadZoneCheckIn.update({
      where: { id: expiredCheckIn.id },
      data: {
        status: 'ALERTED',
        alertedAt: new Date()
      }
    });

    console.log(`[DEADZONE_MONITOR] Alerts completed for check-in ${expiredCheckIn.id}`);
  } catch (err: any) {
    console.error('[DEADZONE_MONITOR] Error during expired deadzone scan:', err.message);
  }
}

export async function checkAllExpiredDeadZones() {
  try {
    const now = new Date();
    const expiredCheckIns = await prisma.deadZoneCheckIn.findMany({
      where: {
        status: 'PENDING',
        gracePeriodEnd: {
          lt: now
        }
      }
    });

    if (expiredCheckIns.length === 0) return;

    console.log(`[DEADZONE_SWEEP] Found ${expiredCheckIns.length} expired check-in sessions. Starting global escalation...`);

    for (const session of expiredCheckIns) {
      console.log(`[DEADZONE_SWEEP] Escalating check-in ${session.id} for user ${session.userId}...`);

      // 1. Transition status to MISSED
      await prisma.deadZoneCheckIn.update({
        where: { id: session.id },
        data: { status: 'MISSED' }
      });

      // 2. Fetch user and contacts
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        include: { contacts: true }
      });

      if (!user) continue;

      // 3. Find registered contacts app user tokens
      const contactsWithFcm = await Promise.all(
        user.contacts.map(async (c) => {
          const contactUser = await prisma.user.findFirst({
            where: {
              phone: {
                equals: c.phone,
                mode: 'insensitive'
              }
            }
          });
          return {
            contact: c,
            fcmToken: contactUser?.fcmToken
          };
        })
      );

      // 4. Dispatch FCM pushes in parallel for this session
      await Promise.all(
        contactsWithFcm
          .filter(c => c.fcmToken)
          .map(async (c) => {
            try {
              await sendDeadZoneAlertPush(
                c.fcmToken!,
                user.name,
                user.phone,
                session.lastLatitude,
                session.lastLongitude,
                null,
                session.id,
                session.lastAccuracy ? Math.round(session.lastAccuracy) : null
              );
            } catch (err: any) {
              console.error(`[DEADZONE_SWEEP] Failed to send FCM alert for session ${session.id} to contact ${c.contact.id}:`, err.message);
            }
          })
      );

      // 5. Transition to ALERTED
      await prisma.deadZoneCheckIn.update({
        where: { id: session.id },
        data: {
          status: 'ALERTED',
          alertedAt: new Date()
        }
      });

      console.log(`[DEADZONE_SWEEP] Escalation finished for check-in ${session.id}`);
    }
  } catch (err: any) {
    console.error('[DEADZONE_SWEEP] Error during global background deadzone scan:', err.message);
  }
}
