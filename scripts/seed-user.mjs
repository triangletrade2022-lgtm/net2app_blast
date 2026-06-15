import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({
  connectionString: 'postgresql://net2app_user:Ariyax2024Net2AppDB@127.0.0.1:5432/net2app_db',
});

async function main() {
  try {
    // Test connection
    const { rows: testRows } = await pool.query('SELECT NOW() as now');
    console.log('DB connected at:', testRows[0].now);

    // Check existing users
    const { rows: users } = await pool.query('SELECT id, username, email, role FROM users');
    console.log('Existing users:', users.length);
    for (const u of users) {
      console.log(`  ID:${u.id} Username:${u.username} Email:${u.email} Role:${u.role}`);
    }

    if (users.length === 0) {
      // Insert superuser
      const hashed = await bcrypt.hash('Telco1988', 10);
      const { rows: inserted } = await pool.query(
        `INSERT INTO users (email, username, password, name, role, is_active, permissions)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        ['superuser@net2app.com', 'superuser', hashed, 'Super User', 'superuser', JSON.stringify({ all: true })]
      );
      console.log('Created superuser with ID:', inserted[0].id);

      // Insert admin
      const hashed2 = await bcrypt.hash('admin123', 10);
      const { rows: inserted2 } = await pool.query(
        `INSERT INTO users (email, username, password, name, role, is_active, permissions)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        ['admin@net2app.com', 'admin', hashed2, 'Admin User', 'admin', JSON.stringify({ manage_users: true, manage_clients: true, manage_suppliers: true })]
      );
      console.log('Created admin with ID:', inserted2[0].id);
    } else {
      console.log('Users already exist, no need to seed.');
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (e.message.includes('relation "users" does not exist')) {
      console.log('Schema not created yet - run migrations first');
      // Try to create the table
      console.log('Creating users table...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          username VARCHAR(100) UNIQUE,
          password TEXT NOT NULL,
          name VARCHAR(255) NOT NULL,
          role VARCHAR(20) NOT NULL DEFAULT 'user',
          is_active BOOLEAN NOT NULL DEFAULT true,
          permissions JSONB DEFAULT '{}',
          last_login TIMESTAMP,
          last_login_ip VARCHAR(50),
          created_by INTEGER,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      console.log('Users table created, run the script again');
    }
  } finally {
    await pool.end();
  }
}

main();
