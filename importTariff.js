import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFile = path.join(__dirname, 'db.json');
const csvFile = path.join(__dirname, 'tariffs.csv');

// Create adapter and database
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { tariffs: [] }); // set default data here

async function importTariffs() {
  await db.read();
  const tariffs = [];

  fs.createReadStream(csvFile)
    .pipe(csv())
    .on('data', (row) => {
      tariffs.push({
        id: Date.now() + Math.random(), // simple unique ID
        code: row.code,
        description: row.description,
        duty: row.duty,
        unit: row.unit
      });
    })
    .on('end', async () => {
      db.data.tariffs = tariffs;
      await db.write();
      console.log('Tariffs imported successfully!');
    });
}

importTariffs();
