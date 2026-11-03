import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:geolocator/geolocator.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:io';

void main() {
  runApp(const PDKSMobileApp());
}

class PDKSMobileApp extends StatelessWidget {
  const PDKSMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PDKS Mobil',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        primarySwatch: Colors.indigo,
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final String serverUrl = "https://pdks-projesi-4wva.onrender.com";
  List<dynamic> users = [];
  int? selectedUserId;
  String deviceUuid = "Yükleniyor...";
  bool isLoading = false;

  @override
  void initState() {
    super.initState();
    _initData();
  }

  Future<void> _initData() async {
    await _getDeviceUuid();
    await _fetchUsers();
  }

  Future<void> _fetchUsers() async {
    try {
      final response = await http.get(Uri.parse('$serverUrl/api/users'));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final fetchedUsers = data['users'] as List<dynamic>;

        setState(() {
          users = fetchedUsers;
          final matchedUser = users.firstWhere(
            (u) => u['device_uuid'] == deviceUuid,
            orElse: () => null,
          );

          if (matchedUser != null) {
            selectedUserId = matchedUser['id'];
          } else if (users.isNotEmpty) {
            selectedUserId = users.first['id'];
          } else {
            selectedUserId = null;
          }
        });
      }
    } catch (e) {
      _showMessage("Hata", "Personel listesi sunucudan alınamadı.");
    }
  }

  Future<void> _getDeviceUuid() async {
    final DeviceInfoPlugin deviceInfo = DeviceInfoPlugin();
    String uuid = "PHONE-UNKNOWN";
    try {
      if (Platform.isAndroid) {
        final androidInfo = await deviceInfo.androidInfo;
        uuid = androidInfo.id;
      } else if (Platform.isIOS) {
        final iosInfo = await deviceInfo.iosInfo;
        uuid = iosInfo.identifierForVendor ?? "IOS-UNKNOWN";
      }
    } catch (e) {
      uuid = "PHONE-${DateTime.now().millisecondsSinceEpoch}";
    }
    setState(() {
      deviceUuid = uuid;
    });
  }

  Future<Position?> _getCurrentLocation() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      _showMessage("Hata", "Lütfen telefonunuzun GPS/Konum servisini açın.");
      return null;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        _showMessage("Hata", "Konum izni verilmedi.");
        return null;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      _showMessage("Hata", "Konum izni kalıcı olarak engellenmiş.");
      return null;
    }

    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 5),
        ),
      );
    } catch (e) {
      return await Geolocator.getLastKnownPosition();
    }
  }

  void _showRegisterDialog() {
    final TextEditingController nameController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Yeni Personel Kaydı"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text("Bu telefon henüz tanımlı değil. Lütfen adınızı yazın:"),
            const SizedBox(height: 12),
            TextField(
              controller: nameController,
              decoration: const InputDecoration(
                labelText: "Ad Soyad",
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text("İptal"),
          ),
          ElevatedButton(
            onPressed: () async {
              if (nameController.text.trim().isEmpty) return;
              Navigator.pop(ctx);
              await _quickRegisterUser(nameController.text.trim());
            },
            child: const Text("Kaydet"),
          ),
        ],
      ),
    );
  }

  Future<void> _quickRegisterUser(String fullName) async {
    setState(() => isLoading = true);
    try {
      final response = await http.post(
        Uri.parse('$serverUrl/api/users/quick-register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'full_name': fullName,
          'device_uuid': deviceUuid,
        }),
      );

      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        _showMessage("Başarılı", "Personel kaydı tamamlandı!");
        await _fetchUsers();
      } else {
        _showMessage("Hata", data['message'] ?? "Kayıt başarısız.");
      }
    } catch (e) {
      _showMessage("Hata", "Sunucuya bağlanılamadı.");
    } finally {
      setState(() => isLoading = false);
    }
  }

  // Personel Silme Fonksiyonu
  Future<void> _deleteSelectedUser() async {
    if (selectedUserId == null) return;

    final userToDelete = users.firstWhere((u) => u['id'] == selectedUserId, orElse: () => null);
    if (userToDelete == null) return;

    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Personeli Sil"),
        content: Text("${userToDelete['full_name']} kullanıcısını silmek istediğinize emin misiniz?"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("İptal")),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text("Sil"),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    setState(() => isLoading = true);
    try {
      final response = await http.delete(Uri.parse('$serverUrl/api/users/$selectedUserId'));
      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        _showMessage("Başarılı", "${userToDelete['full_name']} silindi.");
        setState(() {
          selectedUserId = null;
        });
        await _fetchUsers();
      } else {
        _showMessage("Hata", data['message'] ?? "Silme işlemi başarısız.");
      }
    } catch (e) {
      _showMessage("Hata", "Sunucuya bağlanılamadı.");
    } finally {
      setState(() => isLoading = false);
    }
  }

  void _openScanner(String scanType) async {
    if (selectedUserId == null) {
      _showRegisterDialog();
      return;
    }

    final scannedQrToken = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const QRScannerScreen()),
    );

    if (scannedQrToken != null) {
      _processAttendance(scanType, scannedQrToken);
    }
  }

  Future<void> _processAttendance(String scanType, String qrToken) async {
    setState(() => isLoading = true);

    Position? position = await _getCurrentLocation();
    if (position == null) {
      _showMessage("GPS Hatası", "Konum alınamadı. GPS'inizin açık olduğundan emin olun.");
      setState(() => isLoading = false);
      return;
    }

    try {
      final response = await http.post(
        Uri.parse('$serverUrl/api/attendance/scan'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'user_id': selectedUserId,
          'type': scanType,
          'latitude': position.latitude,
          'longitude': position.longitude,
          'device_uuid': deviceUuid,
        }),
      );

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        _showMessage("BAŞARILI ✅", "${data['message']}\nMesafe: ${data['distance_meters']} metre");
      } else {
        _showMessage("BAŞARISIZ ❌", data['message'] ?? "İşlem reddedildi.");
      }
    } catch (e) {
      _showMessage("Hata", "Sunucuya erişilemedi: $e");
    } finally {
      setState(() => isLoading = false);
    }
  }

  void _showMessage(String title, String message) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text("Tamam"),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("PDKS Mobil Uygulama"),
        backgroundColor: Colors.indigo,
        foregroundColor: Colors.white,
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator())
          : Padding(
              padding: const EdgeInsets.all(20.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Card(
                    color: Colors.indigo.shade50,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    child: Padding(
                      padding: const EdgeInsets.all(16.0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text("📱 Cihaz Kimliği (UUID):", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                          SelectableText(deviceUuid, style: const TextStyle(color: Colors.indigo, fontWeight: FontWeight.w600)),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text("Personel Seçin:", style: TextStyle(fontWeight: FontWeight.bold)),
                      Row(
                        children: [
                          if (selectedUserId != null)
                            IconButton(
                              icon: const Icon(Icons.delete_outline, color: Colors.red),
                              tooltip: "Seçili Personeli Sil",
                              onPressed: _deleteSelectedUser,
                            ),
                          TextButton.icon(
                            onPressed: _showRegisterDialog,
                            icon: const Icon(Icons.person_add, size: 18),
                            label: const Text("Yeni Kayıt"),
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  DropdownButtonFormField<int>(
                    value: selectedUserId,
                    decoration: InputDecoration(
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    ),
                    items: users.map<DropdownMenuItem<int>>((u) {
                      return DropdownMenuItem<int>(
                        value: u['id'],
                        child: Text("${u['full_name']} (${u['branch_name'] ?? 'Merkez'})"),
                      );
                    }).toList(),
                    onChanged: (val) => setState(() => selectedUserId = val),
                  ),
                  const Spacer(),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.green,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text("GİRİŞ QR OKUT", style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    onPressed: () => _openScanner("CHECK_IN"),
                  ),
                  const SizedBox(height: 12),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.amber.shade800,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    icon: const Icon(Icons.logout),
                    label: const Text("ÇIKIŞ QR OKUT", style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    onPressed: () => _openScanner("CHECK_OUT"),
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
    );
  }
}

class QRScannerScreen extends StatefulWidget {
  const QRScannerScreen({super.key});

  @override
  State<QRScannerScreen> createState() => _QRScannerScreenState();
}

class _QRScannerScreenState extends State<QRScannerScreen> {
  bool _isScanned = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("QR Kodu Tarayın")),
      body: MobileScanner(
        onDetect: (capture) {
          if (_isScanned) return;

          final List<Barcode> barcodes = capture.barcodes;
          for (final barcode in barcodes) {
            if (barcode.rawValue != null) {
              setState(() {
                _isScanned = true;
              });
              Navigator.pop(context, barcode.rawValue);
              break;
            }
          }
        },
      ),
    );
  }
}