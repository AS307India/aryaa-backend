import dotenv from 'dotenv';

// Load .env before importing app.ts so JWT_SECRET is present
// when utils/auth.ts runs its startup guard.
dotenv.config();

import { app } from './app.js';


const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = '0.0.0.0'; // Essential to allow the Android emulator to connect via 10.0.2.2

const start = async () => {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server is running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
