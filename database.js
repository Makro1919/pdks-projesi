const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Veritabanı dosyasının oluşturulacağı yer
const dbPath = path.resolve(__dirname, 'pdks.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Veritabanına bağlanırken hata oluştu:', err.message);
  } else {
    console.log('SQLite veritabanına başarıyla bağlanıldı.');
  }
});

// Tabloları Oluşturma
db.serialize(() => {
  // 1. Şubeler / Lokasyonlar Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER DEFAULT 50
    )
  `);

  // 2. Kullanıcılar / Personel Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'EMPLOYEE',
      device_uuid TEXT,
      branch_id INTEGER,
      FOREIGN KEY (branch_id) REFERENCES branches (id)
    )
  `);

  // 3. Giriş - Çıkış Kayıtları Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'CHECK_IN' veya 'CHECK_OUT'
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      latitude REAL,
      longitude REAL,
      status TEXT DEFAULT 'APPROVED', -- 'APPROVED', 'REJECTED_LOCATION', 'REJECTED_DEVICE'
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `, (err) => {
    if (!err) {
      console.log('Veritabanı tabloları hazırlandı.');
    }
  });
});

module.exports = db;