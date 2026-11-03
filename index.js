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

function autoSeedDatabase() {
  db.serialize(() => {
    db.run(`
      INSERT OR REPLACE INTO branches (id, name, latitude, longitude, radius_meters)
      VALUES (1, 'Merkez Ofis', 41.0082, 28.9784, 1000000)
    `);
  });
}

// -------------------------------------------------------------
// ROTALAR
// -------------------------------------------------------------

app.get('/api/seed', (req, res) => {
  autoSeedDatabase();
  res.json({ message: "Test verileri güncellendi!" });
});

app.get('/api/users/by-device/:uuid', (req, res) => {
  const query = `
    SELECT users.*, branches.name as branch_name,
      (SELECT type FROM attendance_logs WHERE user_id = users.id AND status = 'APPROVED' ORDER BY id DESC LIMIT 1) as last_type
    FROM users 
    LEFT JOIN branches ON users.branch_id = branches.id
    WHERE users.device_uuid = ?
  `;
  db.get(query, [req.params.uuid], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ user: row || null });
  });
});

app.get('/api/users', (req, res) => {
  const query = `
    SELECT users.*, branches.name as branch_name 
    FROM users 
    LEFT JOIN branches ON users.branch_id = branches.id
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ users: rows || [] });
  });
});

app.post('/api/users/quick-register', (req, res) => {
  const { full_name, device_uuid } = req.body;

  if (!full_name || !device_uuid) {
    return res.status(400).json({ success: false, message: "İsim ve Cihaz Kimliği zorunludur." });
  }

  const email = `user_${Date.now()}@pdks.local`;
  const query = `
    INSERT INTO users (full_name, email, role, device_uuid, branch_id)
    VALUES (?, ?, 'EMPLOYEE', ?, 1)
  `;

  db.run(query, [full_name, email, device_uuid], function(err) {
    if (err) return res.status(500).json({ success: false, message: "Kayıt hatası." });
    res.json({ success: true, message: "Personel kaydı tamamlandı!", user_id: this.lastID });
  });
});

app.delete('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  db.run(`DELETE FROM attendance_logs WHERE user_id = ?`, [userId], () => {
    db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
      if (err) return res.status(500).json({ success: false, message: "Silinemedi." });
      res.json({ success: true, message: "Personel silindi." });
    });
  });
});

app.get('/api/qr/generate', (req, res) => {
  const timestamp = Date.now();
  const tokenData = `${timestamp}-${QR_SECRET}`;
  const token = crypto.createHash('sha256').update(tokenData).digest('hex');

  res.json({ qr_token: token, timestamp: timestamp, expires_in_seconds: 10 });
});

app.post('/api/attendance/scan', (req, res) => {
  const { type, latitude, longitude, device_uuid } = req.body;

  if (!type || !latitude || !longitude || !device_uuid) {
    return res.status(400).json({ success: false, message: "Eksik bilgi gönderildi." });
  }

  const userQuery = `
    SELECT users.*, branches.latitude as branch_lat, branches.longitude as branch_lng, branches.radius_meters 
    FROM users 
    JOIN branches ON users.branch_id = branches.id 
    WHERE users.device_uuid = ?
  `;

  db.get(userQuery, [device_uuid], (err, user) => {
    if (err || !user) return res.status(404).json({ success: false, message: "Cihaz kayıtlı değil." });

    const lastLogQuery = `
      SELECT type FROM attendance_logs 
      WHERE user_id = ? AND status = 'APPROVED' 
      ORDER BY id DESC LIMIT 1
    `;

    db.get(lastLogQuery, [user.id], (err, lastLog) => {
      if (lastLog) {
        if (lastLog.type === type) {
          const warnMsg = type === 'CHECK_IN' 
            ? "HATA: Zaten giriş yapılmış! Önce çıkış yapmalısınız."
            : "HATA: Zaten çıkış yapılmış! Önce giriş yapmalısınız.";
          return res.status(400).json({ success: false, message: warnMsg });
        }
      } else if (type === 'CHECK_OUT') {
        return res.status(400).json({ success: false, message: "HATA: Henüz giriş kaydınız yok. Önce giriş yapmalısınız." });
      }

      const distance = getDistanceInMeters(latitude, longitude, user.branch_lat, user.branch_lng);

      if (distance > user.radius_meters) {
        db.run(`INSERT INTO attendance_logs (user_id, type, latitude, longitude, status, timestamp) VALUES (?, ?, ?, ?, 'REJECTED_LOCATION', DATETIME('now', '+3 hours'))`, 
          [user.id, type, latitude, longitude]);
        return res.status(400).json({ success: false, message: `HATA: İş yerinin dışındasınız! (${Math.round(distance)}m)` });
      }

      db.run(
        `INSERT INTO attendance_logs (user_id, type, latitude, longitude, status, timestamp) VALUES (?, ?, ?, ?, 'APPROVED', DATETIME('now', '+3 hours'))`,
        [user.id, type, latitude, longitude],
        function(err) {
          if (err) return res.status(500).json({ success: false, message: "Kayıt hatası." });
          res.json({
            success: true,
            message: `${user.full_name} - ${type === 'CHECK_IN' ? 'GİRİŞ' : 'ÇIKIŞ'} Başarılı!`,
            distance_meters: Math.round(distance)
          });
        }
      );
    });
  });
});

// GELİŞMİŞ RAPORLAMA API'Sİ (Log Eşleştirme & Tarih Filtresi)
app.get('/api/reports', (req, res) => {
  const { start_date, end_date, user_id } = req.query;

  let query = `
    SELECT attendance_logs.*, users.full_name, users.email
    FROM attendance_logs
    JOIN users ON attendance_logs.user_id = users.id
    WHERE attendance_logs.status = 'APPROVED'
  `;
  const params = [];

  if (start_date) {
    query += ` AND DATE(attendance_logs.timestamp) >= ?`;
    params.push(start_date);
  }
  if (end_date) {
    query += ` AND DATE(attendance_logs.timestamp) <= ?`;
    params.push(end_date);
  }
  if (user_id && user_id !== 'ALL') {
    query += ` AND attendance_logs.user_id = ?`;
    params.push(user_id);
  }

  query += ` ORDER BY attendance_logs.timestamp ASC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Günlük Giriş/Çıkış Birleştirme Mantığı
    const dailyMap = {};

    rows.forEach(log => {
      const dateStr = log.timestamp.split(' ')[0];
      const key = `${log.user_id}_${dateStr}`;

      if (!dailyMap[key]) {
        dailyMap[key] = {
          date: dateStr,
          user_id: log.user_id,
          full_name: log.full_name,
          check_in: null,
          check_out: null
        };
      }

      if (log.type === 'CHECK_IN' && !dailyMap[key].check_in) {
        dailyMap[key].check_in = log.timestamp;
      } else if (log.type === 'CHECK_OUT') {
        dailyMap[key].check_out = log.timestamp;
      }
    });

    const reportData = Object.values(dailyMap).map(item => {
      let workedMinutes = 0;
      let lateMinutes = 0;
      let earlyExitMinutes = 0;

      if (item.check_in) {
        const inTime = new Date(item.check_in.replace(' ', 'T'));
        const shiftStart = new Date(inTime);
        shiftStart.setHours(9, 0, 0, 0); // Mesai başlangıcı 09:00

        if (inTime > shiftStart) {
          const diff = Math.floor((inTime - shiftStart) / 60000);
          if (diff > 15) { // 15 dakika tolerans
            lateMinutes = diff;
          }
        }
      }

      if (item.check_out) {
        const outTime = new Date(item.check_out.replace(' ', 'T'));
        const shiftEnd = new Date(outTime);
        shiftEnd.setHours(18, 0, 0, 0); // Mesai bitimi 18:00

        if (outTime < shiftEnd) {
          earlyExitMinutes = Math.floor((shiftEnd - outTime) / 60000);
        }
      }

      if (item.check_in && item.check_out) {
        const inTime = new Date(item.check_in.replace(' ', 'T'));
        const outTime = new Date(item.check_out.replace(' ', 'T'));
        workedMinutes = Math.max(0, Math.floor((outTime - inTime) / 60000));
      }

      return {
        ...item,
        worked_minutes: workedMinutes,
        late_minutes: lateMinutes,
        early_exit_minutes: earlyExitMinutes
      };
    });

    res.json({ report: reportData.reverse() });
  });
});

app.get('/api/attendance/logs', (req, res) => {
  const query = `
    SELECT attendance_logs.*, users.full_name, users.email 
    FROM attendance_logs 
    JOIN users ON attendance_logs.user_id = users.id 
    ORDER BY id DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ logs: rows || [] });
  });
});

app.listen(PORT, () => {
  console.log(`PDKS Sunucusu ${PORT} portunda aktif!`);
  autoSeedDatabase();
});