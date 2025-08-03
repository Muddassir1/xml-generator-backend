import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFile = path.join(__dirname, 'db.json');
const csvFile = path.join(__dirname, 'users.csv');

// Create adapter and database
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { users: [] }); // set default data here

async function importUsers() {
  await db.read();
  const users = [];
  let idx = 1;
  fs.createReadStream(csvFile)
    .pipe(csv())
    .on('data', (row) => {
      if (row.name && row.name.trim()) {
        users.push({
          id: idx++,
          name: row.name.trim(),
        });
      }
    })
    .on('end', async () => {
      db.data.users = users;
      await db.write();
      console.log('Users imported successfully!');
    });
}

importUsers();
