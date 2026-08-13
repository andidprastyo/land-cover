
// 1. AREA OF INTEREST (AOI) & KECAMATAN
var AOI = table;
//Map.addLayer(AOI, {color: 'red'}, "Admin Tanah Datar")
//Map.centerObject(AOI, 10)

// 2. LOAD & RESAMPLE SENTINEL-2 (dengan cloud masking SCL)
function maskS2clouds(image) {
  var scl = image.select('SCL');
  var mask = scl.neq(3) //cloud shadow
  .and(scl.neq(8)) //cloud medium
  .and(scl.neq(9)); //cloud high
 // .and(scl.neq(10)); //cirrus
  return image.updateMask(mask).copyProperties(image, ['system:time_start']);
}

var s2Collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(AOI)
  .filterDate('2025-01-01', '2025-12-31')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 50))
  .map(maskS2clouds);

print('Jumlah citra dipakai setelah masking:', s2Collection.size());

var s2 = s2Collection.median().clip(AOI);

// 3. INDEKS SPEKTRAL
var ndvi  = s2.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndwi  = s2.normalizedDifference(['B3', 'B8']).rename('NDWI');
var ndbi  = s2.normalizedDifference(['B11', 'B8']).rename('NDBI');
var mndwi = s2.normalizedDifference(['B3', 'B11']).rename('MNDWI');

var bsi = s2.expression(
  '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))', {
    'SWIR': s2.select('B11'),
    'RED':  s2.select('B4'),
    'NIR':  s2.select('B8'),
    'BLUE': s2.select('B2')
  }
).rename('BSI');

var s2WithIndices = s2
  .addBands(ndvi)
  .addBands(ndbi)
  .addBands(mndwi)
  .addBands(bsi);

// 4. TAMPILKAN DI PETA
//Map.centerObject(AOI, 10);

// Citra Satelit Base
//Map.centerObject(AOI, 10);

var visRGB = {bands: ['B4', 'B3', 'B2'], min: 0, max: 2000};
// var visRGB = {bands: ['B11', 'B8', 'B4'], min: 0, max: 2000};
Map.addLayer(s2, visRGB, 'True Color Sentinel-2 (Tanah Datar)');

// Visualisasi Layer Indeks	
Map.addLayer(ndvi, {min: -0.2, max: 0.8, palette: ['brown', 'yellow', 'lime', 'green', 'darkgreen']}, 'NDVI (Vegetasi)', false);
Map.addLayer(ndbi, {min: -0.5, max: 0.5, palette: ['white', 'orange', 'red', 'darkred']}, 'NDBI (Lahan Terbangun)', false);
Map.addLayer(mndwi, {min: -0.5, max: 0.5, palette: ['white', 'lightblue', 'blue', 'darkblue']}, 'MNDWI (Badan Air)', false);
Map.addLayer(bsi, {min: -0.3, max: 0.3, palette: ['white', 'beige', 'sienna', 'brown']}, 'BSI (Lahan Terbuka)', false);

var classListTanahDatar = [
  {fc: Lahan_Terbangun, val: 1},
  {fc: Lahan_Terbuka, val: 2},
  {fc: Vegetasi, val: 3},
  {fc: Badan_Air, val: 4}
];

// Merge Semua Poligon Sampel
var createSamples = function(classList) {
  var mergedCollections = classList.map(function(item) {
    return item.fc.map(function(feature) {
      return feature.set('classification', item.val);
    });
  });
  return ee.FeatureCollection(mergedCollections).flatten().filterBounds(AOI);
};

var allSamples = createSamples(classListTanahDatar);
print('Total poligon sampel:', allSamples.size());

// 6. EKSTRAKSI PIKSEL & BAND UNTUK TRAINING
var bandsForClassification = [
  'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A', 'B11', 'B12',
  'NDVI', 'NDBI', 'MNDWI', 'BSI'
];

var sampelDenganNilai = s2WithIndices.select(bandsForClassification).sampleRegions({
  collection: allSamples,
  properties: ['classification'],
  scale: 10,
  geometries: true
});

print('Distribusi piksel per kelas:', sampelDenganNilai.aggregate_histogram('classification'));
print('Total piksel terekstrak (Cochran check):', sampelDenganNilai.size());

// 7. SPLIT DATA 80% TRAINING & 20% VALIDASI
var sampelWithRandom = sampelDenganNilai.randomColumn('random', 48);
var trainingData = sampelWithRandom.filter(ee.Filter.lt('random', 0.8));
var validasiData = sampelWithRandom.filter(ee.Filter.gte('random', 0.2));

print('Training sampel (80%):', trainingData.size());
print('Validasi sampel (20%):', validasiData.size()); 

// 8. RANDOM FOREST CLASSIFIER
var classifier = ee.Classifier.smileRandomForest({numberOfTrees: 500, seed: 42}).train({
  features: trainingData,
  classProperty: 'classification',
  inputProperties: bandsForClassification
});

var classified = s2WithIndices.select(bandsForClassification)
  .classify(classifier)
  .clip(AOI);

// Tampilkan Hasil Klasifikasi di Peta
Map.addLayer(classified, {
  min: 1, max: 4,
  palette: [
    '#ff0000',
    '#d2b48c',
    '#32cd32',
    '#0b4a8b'
  ]
}, 'Land Cover Tanah Datar (Random Forest)');

// 9. LEGENDA
var legend = ui.Panel({
  style: {
    position: 'bottom-left',
    padding: '8px 15px'
  }
});

legend.add(ui.Label('Legenda Land Cover Tanah Datar', {
  fontWeight: 'bold',
  fontSize: '14px',
  margin: '0 0 6px 0'
}));

var kelasLegenda = [
  {nama: 'Lahan Terbangun', warna: '#ff0000'},
  {nama: 'Lahan Terbuka', warna: '#d2b48c'},
  {nama: 'Vegetasi', warna: '#32cd32'},
  {nama: 'Badan Air', warna: '#0b4a8b'}
];

kelasLegenda.forEach(function(kelas) {
  legend.add(ui.Panel([
    ui.Label({
      style: {
        backgroundColor: kelas.warna,
        padding: '8px',
        margin: '4px 8px 4px 0'
      }
    }),
    ui.Label(kelas.nama, {margin: '4px 0'})
  ], ui.Panel.Layout.Flow('horizontal')));
});

Map.add(legend);

// 10. ACCURACY (CONFUSION MATRIX)
var validasiDataRef = validasiData.map(function(f) {
  return f.set('reference', f.get('classification'));
});

var validasiTerklasifikasi = validasiDataRef.classify(classifier);
var cm = validasiTerklasifikasi.errorMatrix('reference', 'classification');

print('=== ACCURACY - Tanah Datar ===');
print('Confusion Matrix:', cm);
print('Overall Accuracy:', cm.accuracy());
print('Kappa Coefficient:', cm.kappa());
print('Producer Accuracy:', cm.producersAccuracy());
print('User Accuracy:', cm.consumersAccuracy());

// 11. PERHITUNGAN LUAS PER KELAS
var areaImg = ee.Image.pixelArea().divide(1e6).addBands(classified.rename('class'));
var stats = areaImg.reduceRegion({
  reducer: ee.Reducer.sum().group({
    groupField: 1,
    groupName: 'class'
  }),
  geometry: AOI,
  scale: 10,
  maxPixels: 1e13
});

var luasPerKelas = ee.List(stats.get('groups')).map(function(g) {
  g = ee.Dictionary(g);
  var cls = ee.Number(g.get('class'));
  var area = ee.Number(g.get('sum')).format('%.3f');
  var label = ee.Algorithms.If(cls.eq(1), 'Lahan_Terbangun',
              ee.Algorithms.If(cls.eq(2), 'Lahan_Terbuka',
              ee.Algorithms.If(cls.eq(3), 'Vegetasi',
              ee.Algorithms.If(cls.eq(4), 'Badan_Air'))));
  return ee.Feature(null, {'Kelas': label, 'Luas_km2': area});
});

print('Luas per Kelas Land Cover Agam (km²):', ee.FeatureCollection(luasPerKelas));

// 12. EXPORT HASIL KE GOOGLE DRIVE
Export.image.toDrive({
  image: classified, 
  description: 'LandCover_Agam_RF',
  folder: 'GEE_Exports', 
  region: AOI, 
  scale: 10, 
  crs: 'EPSG:32747',
  maxPixels: 1e13
});

Export.table.toDrive({
  collection: allSamples,
  description: 'Sampel_Agam_Polygon',
  folder: 'GEE_Daerah_Agam',
  fileFormat: 'SHP'
});

var classifiedMasked = classified.selfMask().toInt16();

Export.image.toDrive({
  image: classifiedMasked.clip(AOI),
  description: 'LandCover_Agam_DN',
  folder: 'GEE_Daerah_Agam',
//  region: BatasAdmin.geometry(),
  scale: 10,
  crs: 'EPSG:32747',
  maxPixels: 1e13,
  formatOptions: {noData: 0} 
});

