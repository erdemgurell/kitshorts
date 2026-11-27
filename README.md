# KitShorts

PDF kitabını yükle, paragraf paragraf kaydırarak oku. Metin içeren PDF'ler doğrudan, taranmış sayfalar OCR (Türkçe/İngilizce) ile okunur. Dosya cihazdan çıkmaz; kitaplık ve okuma konumu cihazda saklanır.

## Kamerayla kitap tarama

PDF'i olmayan basılı kitaplar için: kitaplıkta **📷 Kitap tara** → kitaba isim ver. Kitap bir klasör gibi açılır:

- **Sayfa çek**: kamera her çekimden sonra kendiliğinden yeniden açılır (seri çekim); bitince geri tuşuyla çık.
- **Galeriden ekle**: daha önce çekilmiş sayfaları toplu seç (seçim sırasıyla eklenir).
- Her fotoğraf arka planda OCR'lanır; sayfalar arası bölünen paragraflar birleştirilir, sayfa no ve üst bilgiler atılır.
- Sayfaya dokununca: okunan metnin önizlemesi, öne/geri alma, yeniden çekme, tekrar okuma, silme.
- Klasörden çıkıp sonra girerek kaldığın yerden sayfa eklemeye ve okumaya devam edebilirsin; yarıda kalan sayfalar klasör açılınca okunmaya devam eder.

İpucu: her karede tek sayfa olsun, sayfa düz ve iyi ışıkta olsun. Fotoğraflar (sıkıştırılmış hâlde) cihazda kitapla birlikte saklanır.

## Android'e kurulum (APK)

1. [Releases](../../releases/latest) sayfasından `KitShorts-x.y.z.apk` dosyasını telefona indir.
2. Dosyayı aç; Android "bilinmeyen kaynaklardan yükleme" izni isterse tarayıcıya / dosya yöneticisine izin ver.
3. Kur ve aç. Taranmış PDF'lerde OCR ilk kullanımda dil modelini indirdiği için internet gerekir.

Uygulama Play Store'da yok; güncellemeler yine Releases sayfasından kurulur (eski sürümün üstüne yüklenir, kitaplık korunur).

## Geliştirme

```bash
npm install
npm run dev          # tarayıcıda çalıştır
npm run build        # dist/ üret
npx cap sync android # web derlemesini android/ projesine kopyala
```

Android projesi [Capacitor](https://capacitorjs.com) ile `android/` klasöründe.

## Yeni sürüm çıkarma

`package.json` sürümünü artır, commit'le ve tag gönder:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/android-release.yml` APK'yı derler, imzalar ve aynı isimli GitHub Release'e ekler. İmza için depo secret'ları gerekir: `ANDROID_KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
