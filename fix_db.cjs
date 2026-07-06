require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
client.connect()
  .then(() => client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = $1', ['20260706000000_init']))
  .then(r => { console.log('Deleted rows:', r.rowCount); return client.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
