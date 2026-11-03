const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const QR_SECRET = "pdks_gizli_anahtar_2026";

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const radLat1 = lat1 * Math.PI / 180;
  const radLat2 = lat2 * Math.PI / 180;
  const deltaLat = (lat2 - lat1) * Math.PI / 180;
  const deltaLon = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// -------------------------------------------------------------
// ŞUBE VEYA TEST VERİSİ ROTALARI
// -------------------------------------------------------------
app.get('/api/seed', (req, res) => {
  // Önceki test verilerini temizle
  db.serialize(() => {
    db.run(`DELETE FROM attendance_logs`);
    db.run(`DELETE FROM users`);
    db.run(`DELETE FROM branches`);

    db.run(`
      INSERT INTO branches (name, latitude, longitude, radius_meters)
      VALUES ('Merkez Ofis', 41.0082, 28.9784, 50)
    `, function(err) {
      if (err) return res.status(500).json({ error: "Şube eklenemedi: " + err.message });
      
      const branchId = this.lastID;
      // Cihaz UUID'si senin telefonun (AQ3A.250226.002) olarak güncellendi
      db.run(`
        INSERT INTO users (full_name, email, role, device_uuid, branch_id)
        VALUES ('Ahmet Yılmaz', 'ahmet@sirket.com', 'EMPLOYEE', 'AQ3A.250226.002', ?)
      `, [branchId], function(err) {
        if (err) return res.status(500).json({ error: "Personel eklenemedi: " + err.message });
        res.json({ message: "Test verileri başarıyla güncellendi!", branch_id: branchId, user_id: this.lastID, device_uuid: 'AQ3A.250226.002' });
      });
    });
  });
});

// Tüm Şubeleri Listele
app.get('/api/branches', (req, res) => {
  db.all('SELECT * FROM branches', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ branches: rows });
  });
});

// -------------------------------------------------------------
// PERSONEL YÖNETİM ROTALARI
// -------------------------------------------------------------
app.get('/api/users', (req, res) => {
  const query = `
    SELECT users.*, branches.name as branch_name 
    FROM users 
    LEFT JOIN branches ON users.branch_id = branches.id
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ users: rows });
  });
});

app.post('/api/users', (req, res) => {
  const { full_name, email, role, device_uuid, branch_id } = req.body;

  if (!full_name || !email || !branch_id) {
    return res.status(400).json({ success: false, message: "Ad Soyad, E-posta ve Şube zorunludur." });
  }

  const query = `
    INSERT INTO users (full_name, email, role, device_uuid, branch_id)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(query, [full_name, email, role || 'EMPLOYEE', device_uuid, branch_id], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, message: "Bu e-posta adresi zaten kayıtlı!" });
      }
      return res.status(500).json({ success: false, message: "Personel eklenirken hata oluştu." });
    }

    res.json({
      success: true,
      message: `${full_name} sisteme başarıyla eklendi!`,
      user_id: this.lastID
    });
  });
});

// -------------------------------------------------------------
// QR KOD & DEVAM TAKİP ROTALARI
// -------------------------------------------------------------
app.get('/api/qr/generate', (req, res) => {
  const timestamp = Date.now();
  const tokenData = `${timestamp}-${QR_SECRET}`;
  const token = crypto.createHash('sha256').update(tokenData).digest('hex');

  res.json({
    qr_token: token,
    timestamp: timestamp,
    expires_in_seconds: 10
  });
});

app.post('/api/attendance/scan', (req, res) => {
  const { user_id, type, latitude, longitude, device_uuid } = req.body;

  if (!user_id || !type || !latitude || !longitude || !device_uuid) {
    return res.status(400).json({ success: false, message: "Eksik bilgi gönderildi." });
  }

  const query = `
    SELECT users.*, branches.latitude as branch_lat, branches.longitude as branch_lng, branches.radius_meters 
    FROM users 
    JOIN branches ON users.branch_id = branches.id 
    WHERE users.id = ?
  `;

  db.get(query, [user_id], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ success: false, message: "Kullanıcı veya şube bulunamadı." });
    }

    // Eğer kullanıcının henüz cihaz kaydı yoksa gelen cihazı otomatik eşleştir
    if (!user.device_uuid) {
      db.run(`UPDATE users SET device_uuid = ? WHERE id = ?`, [device_uuid, user_id]);
      user.device_uuid = device_uuid;
    }

    // Cihaz doğrulama kontrolü
    if (user.device_uuid && user.device_uuid !== device_uuid) {
      db.run(`INSERT INTO attendance_logs (user_id, type, latitude, longitude, status) VALUES (?, ?, ?, ?, 'REJECTED_DEVICE')`, 
        [user_id, type, latitude, longitude]);
      return res.status(403).json({ success: false, message: "HATA: Tanımsız cihaz! Kendi telefonunuzdan giriş yapmalısınız." });
    }

    const distance = getDistanceInMeters(latitude, longitude, user.branch_lat, user.branch_lng);

    if (distance > user.radius_meters) {
      db.run(`INSERT INTO attendance_logs (user_id, type, latitude, longitude, status) VALUES (?, ?, ?, ?, 'REJECTED_LOCATION')`, 
        [user_id, type, latitude, longitude]);
      return res.status(400).json({ 
        success: false, 
        message: `HATA: İş yerinin dışındasınız! (Mesafe: ${Math.round(distance)} metre. Sınır: ${user.radius_meters}m)` 
      });
    }

    db.run(
      `INSERT INTO attendance_logs (user_id, type, latitude, longitude, status) VALUES (?, ?, ?, ?, 'APPROVED')`,
      [user_id, type, latitude, longitude],
      function(err) {
        if (err) return res.status(500).json({ success: false, message: "Kayıt oluşturulurken hata." });
        
        res.json({
          success: true,
          message: `${user.full_name} için ${type === 'CHECK_IN' ? 'GİRİŞ' : 'ÇIKIŞ'} işlemi başarılı!`,
          distance_meters: Math.round(distance)
        });
      }
    );
  });
});

app.get('/api/attendance/logs', (req, res) => {
  const query = `
    SELECT attendance_logs.*, users.full_name, users.email 
    FROM attendance_logs 
    JOIN users ON attendance_logs.user_id = users.id 
    ORDER BY timestamp DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ logs: rows });
  });
});

app.listen(PORT, () => {
  console.log(`PDKS Sunucusu http://localhost:${PORT} adresinde aktif!`);
});