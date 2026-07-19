import dotenv from 'dotenv';

// Load .env before importing app.ts so JWT_SECRET is present
// when utils/auth.ts runs its startup guard.
dotenv.config();

import { app } from './app.js';


import { checkAllExpiredDeadZones } from './utils/deadzone.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = '0.0.0.0'; // Essential to allow the Android emulator to connect via 10.0.2.2

const start = async () => {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server is running at http://${HOST}:${PORT}`);

    // Global background sweep for expired check-in sessions running on a 30s cadence.
    // NOTE: This naive per-instance setInterval is an accepted v1 tradeoff for single-instance scale.
    // Before scaling horizontally to multiple server instances, transition this to a distributed lock
    // (e.g., Redis/Redlock), database-level locking, or a centralized cron service (e.g., Render Cron Jobs)
    // to prevent racing instances from executing duplicate database sweeps and duplicate FCM dispatches.
    setInterval(() => {
      checkAllExpiredDeadZones().catch(err => {
        console.error('[DEADZONE_BACKGROUND_SWEEP] Background sweep error:', err.message);
      });
    }, 30000);
    console.log('[DEADZONE_BACKGROUND_SWEEP] Recurring 30s global sweep interval started.');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
