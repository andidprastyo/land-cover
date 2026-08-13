# Technical Documentation — Land Cover Classification (LULC)

**Project:** Land Cover Tanah Datar / Agam, Sumatera Barat  
**Platform:** Google Earth Engine (GEE) → QGIS → Google Drive  
**Data source:** Sentinel-2 MSI (COPERNICUS/S2_SR_HARMONIZED)

---

## 1. Cloud Masking pada Codingan GEE

Sumber data utama adalah **Sentinel-2 Surface Reflectance (SR) Harmonized**. Untuk menghilangkan piksel awan (cloud) dan bayangan awan (cloud shadow), digunakan mask berbasis **Scene Classification Layer (SCL)**.

**Kode GEE:**

```js
function maskS2clouds(image) {
  var scl = image.select('SCL');
  var mask = scl.neq(3)   // cloud shadow
    .and(scl.neq(8))      // cloud medium
    .and(scl.neq(9));     // cloud high
  // .and(scl.neq(10));   // cirrus (opsional, sengaja dinonaktifkan)
  return image.updateMask(mask).copyProperties(image, ['system:time_start']);
}
```

**Logika mask (nilai SCL):**

| Nilai SCL | Kelas             | Aksi pada mask |
|-----------|-------------------|----------------|
| 3         | Cloud shadow      | Dibuang         |
| 8         | Cloud medium      | Dibuang         |
| 9         | Cloud high        | Dibuang         |
| 7         | Cloud low         | Dibuang (opsional) |
| 10        | Cirrus            | Dipertahankan (dinonaktifkan) |

**Filter koleksi citra:**

```js
var s2Collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(AOI)
  .filterDate('2025-01-01', '2025-12-31')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 50))
  .map(maskS2clouds);

var s2 = s2Collection.median().clip(AOI);
```

Citra digabung menggunakan **median composite** untuk mereduksi sisa tutupan awan pada citra tahun 2025.

---

## 2. Sampling Dataset Menggunakan PolyLines

Sampel training dikumpulkan dengan **PolyLine (LineString)** di atas citra GEE. LineString ditarik mengikuti area yang homogen pada masing-masing kelas penutup lahan, sehingga piksel yang terekstraksi berasal dari garis yang memotong area sampel.

> **Catatan:** Penggunaan LineString/PolyLine memerlukan buffer agar mendapatkan area piksel, atau dapat juga menggunakan polygon kecil (jika ingin langsung memakai `sampleRegions`). Pada kode saat ini, `sampleRegions` dijalankan pada poligon; untuk PolyLine sebaiknya ditambahkan `ee.Image.reduceToVectors` atau buffer terlebih dahulu.

**Kode ekstraksi piksel:**

```js
var sampelDenganNilai = s2WithIndices.select(bandsForClassification).sampleRegions({
  collection: allSamples,
  properties: ['classification'],
  scale: 10,
  geometries: true
});
```

---

## 3. Standarisasi Geometri Sampel

Setiap kelas sampel didefinisikan sebagai **FeatureCollection** dengan **Property `classification`** dan **value numerik** yang disesuaikan dengan tabel standar kelas penutup lahan:

| Kelas           | FeatureCollection | Value (`classification`) |
|-----------------|-------------------|--------------------------|
| Lahan Terbangun | `Lahan_Terbangun` | 1                        |
| Lahan Terbuka   | `Lahan_Terbuka`   | 2                        |
| Vegetasi        | `Vegetasi`        | 3                        |
| Badan Air       | `Badan_Air`       | 4                        |

**Kode GEE:**

```js
var classListTanahDatar = [
  {fc: Lahan_Terbangun, val: 1},
  {fc: Lahan_Terbuka, val: 2},
  {fc: Vegetasi, val: 3},
  {fc: Badan_Air, val: 4}
];

var createSamples = function(classList) {
  var mergedCollections = classList.map(function(item) {
    return item.fc.map(function(feature) {
      return feature.set('classification', item.val);
    });
  });
  return ee.FeatureCollection(mergedCollections).flatten().filterBounds(AOI);
};

var allSamples = createSamples(classListTanahDatar);
```

Standarisasi ini memastikan seluruh geometri sampel memiliki **skema atribut yang seragam** (`classification` dengan nilai integer 1-4) sehingga kompatibel dengan proses training dan validasi.

---

## 4. Output GEE dalam Bentuk GeoTIFF

Hasil klasifikasi Random Forest diekspor sebagai **GeoTIFF** (raster) dengan CRS UTM zona 47S (`EPSG:32747`).

**Kode GEE:**

```js
Export.image.toDrive({
  image: classified,
  description: 'LandCover_Agam_RF',
  folder: 'GEE_Exports',
  region: AOI,
  scale: 10,
  crs: 'EPSG:32747',
  maxPixels: 1e13
});

var classifiedMasked = classified.selfMask().toInt16();
Export.image.toDrive({
  image: classifiedMasked.clip(AOI),
  description: 'LandCover_Agam_DN',
  folder: 'GEE_Daerah_Agam',
  scale: 10,
  crs: 'EPSG:32747',
  maxPixels: 1e13,
  formatOptions: {noData: 0}
});
```

**Spesifikasi output raster:**

| Parameter       | Nilai                              |
|-----------------|------------------------------------|
| Format          | GeoTIFF                            |
| Resolusi (scale)| 10 m                               |
| CRS             | EPSG:32747 (UTM 47S)               |
| Nilai kelas     | 1 – 4 (integer), `noData` = 0      |

---

## 5. Clip Sesuai AOI di Aplikasi QGIS

Output GeoTIFF yang diekspor dari GEE sudah di-clip ke AOI, namun sebagai kontrol akhir dilakukan proses **clip ulang di QGIS** agar memastikan batas area sesuai batas administrasi yang valid.

**Langkah di QGIS:**

1. Muat raster `LandCover_Agam_DN.tif` di QGIS.
2. Muat layer batas administrasi AOI (mis. Shapefile/GeoPackage batas kecamatan).
3. Gunakan menu **Raster → Extraction → Clip Raster by Mask Layer**.
4. Pilih layer mask = batas administrasi, beri centang **Crop the extent of the dataset to the extent of the mask layer**.
5. Simpan output sebagai GeoTIFF baru.
6. *(Opsional)* Rapikan piksel pinggiran dengan **sieve** (Raster → Raster Analysis → Sieve) untuk menghilangkan piksel kecil/salt-pepper.

---

## 6. Vectorize Raster LULC Menjadi Vector

Raster hasil klasifikasi dikonversi menjadi vektor (poligon) menggunakan **Polygonize** di QGIS.

**Langkah di QGIS:**

1. Muat raster hasil clip (nilai integer 1-4).
2. Menu **Raster → Conversion → Polygonize (Raster to Vector)**.
3. Kolom field nama = `DN` (nilai kelas).
4. Hasilnya berupa poligon `MultiPolygon` dengan atribut `DN` (1-4).
5. Simplifikasi geometri (jika diperlukan) untuk memperkecil ukuran file: **Vector → Geometry Tools → Simplify**.

> **Catatan:** Raster yang telah di-*sieve* sebelum polygonize akan menghasilkan poligon yang lebih bersih.

---

## 7. Penyesuaian/Editing Atribut Tabel Sesuai Format Database

Setelah vectorize, tabel atribut masih berisi kolom `DN`. Lakukan penyesuaian agar sesuai format database (mis. Telkomsat / GIS database).

**Standar atribut tabel:**

| Field        | Tipe     | Deskripsi                                  | Contoh          |
|--------------|----------|--------------------------------------------|-----------------|
| `fid`        | Integer  | ID unik fitur                              | 1, 2, 3 ...     |
| `landcover`  | Integer  | Kode kelas (1-4)                           | 1               |
| `kelas`      | Text     | Nama kelas penutup lahan                   | Lahan Terbangun |
| `luas_ha`    | Double   | Luas (hektar)                              | 125.36          |
| `luas_km2`   | Double   | Luas (kilometer persegi)                   | 1.2536          |
| `kabupaten`  | Text     | Nama kabupaten (sesuai AOI)                | Tanah Datar     |
| `tahun`      | Integer  | Tahun data                                 | 2025            |

**Langkah di QGIS:**

1. Buka tabel atribut (`F6`).
2. Gunakan **Field Calculator** untuk menambahkan kolom:
   - `kelas` → case/expression mapping dari `DN` ke nama kelas.
   - `luas_ha` → `area($geometry) / 10000`.
   - `luas_km2` → `area($geometry) / 1000000`.
   - `kabupaten`, `tahun` → nilai konstanta.
3. Lakukan *editing* atribut (mis. perbaikan kelas hasil interpretasi manual) bila diperlukan.
4. Simpan hasil sebagai GeoPackage (`.gpkg`) untuk proses selanjutnya.

---

## 8. Proyeksi Peta ke WGS84 dan TM/UTM Sesuai Zona

Data diproyeksikan dalam **dua sistem koordinat** sesuai kebutuhan:

| Sistem Koordinat | EPSG  | Penggunaan                         |
|------------------|-------|------------------------------------|
| UTM (TM) 47S     | 32747 | Analisis spasial & perhitungan luas (presisi) |
| WGS 84           | 4326  | Distribusi/Web (GeoJSON publikasi) |

**Langkah di QGIS:**

1. **Reproject ke UTM 47S** (jika belum): menu **Vector → Data Management Tools → Reproject Layer**, target CRS `EPSG:32747`. Digunakan untuk akurasi perhitungan luas.
2. **Reproject ke WGS 84**: jalankan **Reproject Layer** kedua dengan target CRS `EPSG:4326` untuk kebutuhan GeoJSON.
3. Periksa pada **Project → Properties → CRS** untuk memastikan proyeksi sesuai zona (zona UTM untuk Sumatera Barat bagian selatan adalah **47S**).

---

## 9. Export Output dalam Bentuk GeoJSON

Hasil vektor diekspor sebagai **GeoJSON** (dalam CRS WGS84 / EPSG:4326).

**Langkah di QGIS:**

1. Muat layer vektor hasil editing atribut (dalam CRS WGS84).
2. Klik kanan layer → **Export → Save Features As...**.
3. Format = **GeoJSON**.
4. File name = `landcover_tanah_datar_2025.geojson`.
5. CRS = `EPSG:4326 - WGS 84`.
6. Centang **Save only selected features** (jika hanya ingin mengekspor sebagian) dan tentukan field yang diperlukan.

> Alternatif di GEE (jika hasil langsung dari cloud): `Export.table.toDrive` dengan `fileFormat: 'GeoJSON'`.

---

## 10. Upload Google Drive dalam Bentuk GeoTIFF & GeoJSON

Produk akhir diunggah ke **Google Drive** dalam dua format:

| Format  | File contoh                       | Keterangan                 |
|---------|-----------------------------------|----------------------------|
| Raster  | `landcover_tanah_datar_2025.tif` | GeoTIFF hasil clip QGIS (EPSG:32747) |
| Vector  | `landcover_tanah_datar_2025.geojson` | GeoJSON WGS84 (EPSG:4326) |

**Struktur folder tujuan (Google Drive):**

```
Google Drive/
└── LULC_TanahDatar/
    ├── Raster/
    │   └── landcover_tanah_datar_2025.tif
    └── Vector/
        └── landcover_tanah_datar_2025.geojson
```

**Langkah:**

1. Dari GEE, task **Export image to Drive** menghasilkan GeoTIFF di folder `GEE_Exports`.
2. Dari QGIS, ekspor GeoJSON hasil edit atribut.
3. Upload kedua file ke Google Drive sesuai struktur folder di atas.
4. *(Opsional)* Verifikasi file dengan membuka di GEE via `ee.FeatureCollection('asset')` atau di QGIS.

---

### Parameter klasifikasi

| Parameter           | Nilai                    |
|---------------------|--------------------------|
| Classifier          | Random Forest            |
| Jumlah trees        | 500                      |
| Seed                | 42                       |
| Split data          | 80% training / 20% validasi |
| Band untuk klasifikasi | B2, B3, B4, B5, B6, B7, B8, B8A, B11, B12, NDVI, NDBI, MNDWI, BSI |
| Skala               | 10 m                     |

---

## Referensi

- Google Earth Engine: Sentinel-2 SR Harmonized — `COPERNICUS/S2_SR_HARMONIZED`
- Sentinel-2 Scene Classification Layer (SCL) — ESA
- QGIS Documentation: Raster to Vector (Polygonize), Clip Raster by Mask Layer
