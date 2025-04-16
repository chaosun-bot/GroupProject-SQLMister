/*************************************************
 * 数据预处理 – 基于 GST 参数筛选
 * 目标：仅依据生长季（4–10月）平均气温（GST）来生成适宜性掩膜，
 *       筛选条件：14.1°C ≤ GST ≤ 15.5°C
 *
 * 数据来源：
 *   - TerraClimate: IDAHO_EPSCOR/TERRACLIMATE
 *     2024 年数据中，主要波段为 tmmx（最高温）和 tmmn（最低温），数值放大10倍
 *   - 英国边界：USDOS/LSIB_SIMPLE/2017
 *************************************************/

/***** 1. 定义英国边界 (ROI) *****/
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));
print("UK Boundary:", UK_boundary);
Map.centerObject(UK_boundary, 6);
Map.addLayer(UK_boundary, {color: 'red', width: 2}, "UK Boundary (Raw)");

/***** 2. 导入 TerraClimate 数据 *****/
// 使用 TerraClimate 2024 年数据（如有数据，否则请调整年份）
var terraclimate = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE")
                    .filterBounds(UK_boundary)
                    .filterDate("2024-01-01", "2024-12-31");

/***** 3. 筛选生长季 (4–10月) 数据 *****/
// 选取生长季数据，并选择 tmmx 和 tmmn 波段
var growingSeason = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select(["tmmx", "tmmn"]);
print("Growing Season Collection:", growingSeason.limit(5));

/***** 4. 计算每月 tmean *****/
// tmean = (tmmx + tmmn) / 2，其中 tmmx 和 tmmn 除以 10 得到真实温度 (°C)
var withTmean = growingSeason.map(function(img) {
  var tmaxC = img.select("tmmx").divide(10);
  var tminC = img.select("tmmn").divide(10);
  var tmean = tmaxC.add(tminC).divide(2).rename("tmean");
  return img.addBands(tmean);
});
print("Monthly tmean sample:", withTmean.limit(5));

/***** 5. 计算生长季平均气温 GST *****/
// 对生长季 (4–10月) 所有 tmean 影像取平均
var GST = withTmean.select("tmean").mean().clip(UK_boundary).rename("GST");
print("GST Image:", GST);
Map.addLayer(GST, {min: 10, max: 20, palette: ['blue', 'green', 'yellow', 'red']}, "GST (°C)");

/***** 6. 根据 GST 参数筛选适宜区域 *****/
// 适宜性条件：GST 在 14.1°C 到 15.5°C 之间
var gstMask = GST.gte(14.1).and(GST.lte(15.5));
print("GST Suitability Mask:", gstMask);

// 将 mask 应用后仅显示满足条件的区域
Map.addLayer(gstMask.updateMask(gstMask), {palette: ['green']}, "GST Suitability Mask");

/*************************************************
 * 计算 GDD: Growing Degree Days (生长积温)
 * 前提：已获得生长季（4–10月）的月均温 tmean (单位 °C)
 * 计算方法：
 *   GDD_month = max(0, tmean - baseTemp) * days_in_month
 *   假设每个月固定为30天，基温取10°C（可根据需要调整）
 *************************************************/

// 设定基温
var baseTemp = 10;

// 在之前步骤中，我们已经得到了 withTmean 这个 ImageCollection，其中包含每个月份生长季的 tmean 波段。
// 示例：如果你还没有计算，可以参考下列代码片段（假设使用 TerraClimate 的 tmmx/tmmn 并除以10得到 tmean）：
/*
var growingSeason = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select(["tmmx", "tmmn"]);
var withTmean = growingSeason.map(function(img) {
  var tmaxC = img.select("tmmx").divide(10);
  var tminC = img.select("tmmn").divide(10);
  var tmean = tmaxC.add(tminC).divide(2).rename("tmean");
  return img.addBands(tmean);
});
*/

// 现在计算每个月的 GDD：GDD_month = max(0, tmean - baseTemp) * 30
var monthlyGDD = withTmean.map(function(img) {
  var tmean = img.select("tmean");
  var gdd = tmean.subtract(baseTemp).max(0).multiply(30).rename("gdd");
  return gdd.copyProperties(img, img.propertyNames());
});

// 累加所有生长季月份的 GDD, 得到整个生长季的总生长积温
var GDD = monthlyGDD.sum().clip(UK_boundary).rename("GDD");

// 将 GDD 影像添加到地图上进行可视化（根据实际数据调节 min/max 参数）
Map.addLayer(GDD, {min: 500, max: 1500, palette: ['white', 'red']}, "GDD (°C-days)");

// 打印 GDD 统计信息以供调试
var gddStats = GDD.reduceRegion({
  reducer: ee.Reducer.minMax().combine({
    reducer2: ee.Reducer.mean(),
    sharedInputs: true
  }),
  geometry: UK_boundary,
  scale: 4000,
  maxPixels: 1e9
});
print("GDD Statistics:", gddStats);

/***** 根据 GDD 参数筛选适宜区域 *****/
// 适宜性条件：GDD 在 974 到 1223 °C·days 之间
var gddMask = GDD.gte(974).and(GDD.lte(1223));
print("GDD Suitability Mask (binary):", gddMask);

// 将掩膜应用到地图上：仅显示满足条件的区域，设定调色板为绿色
Map.addLayer(gddMask.updateMask(gddMask), {palette: ['green']}, "GDD Suitability Mask");

/***** 计算 GSP: 生长季降水量 (4–10月) *****/
// 采用 TerraClimate 数据中的 'pr' 波段，单位为 mm
// 此处假设你已经完成前面的数据导入和 ROI (UK_boundary) 的设置

// 筛选生长季（4–10月）的 TerraClimate 数据，并选择 'pr' 波段
var growingSeasonGSP = terraclimate.filter(ee.Filter.calendarRange(4, 10, 'month'))
                                .select("pr");

// 对生长季数据进行累加（求和），得到降水量（GSP），并裁剪至英国区域
var GSP = growingSeasonGSP.sum().clip(UK_boundary).rename("GSP");

// 添加图层进行可视化，参考可视化参数可根据实际数据调整
Map.addLayer(GSP, {min: 200, max: 700, palette: ['white', 'blue']}, "GSP (mm)");
print("GSP Image:", GSP);

/***** 根据 GSP 数值范围筛选适宜区域 *****/
// 适宜性条件：GSP >= 273 mm 且 GSP <= 449 mm
var gspMask = GSP.gte(273).and(GSP.lte(449));
print("GSP Suitability Mask (binary):", gspMask);

// 使用更新掩膜 (updateMask) 只显示满足条件的区域，并用蓝色调色板显示
Map.addLayer(gspMask.updateMask(gspMask), {palette: ['blue']}, "GSP Suitability Mask");

/*************************************************
 * 计算 FlavorHours：风味酶活性温度区间小时数
 *   时间段：2024-07-20 至 2024-09-20
 *   条件：温度在 16–22°C（ERA5-Land 的 temperature_2m 波段，单位 K）
 * 输出：FlavorHours（累计小时数）
 *************************************************/

// 1. 定义英国边界 ROI
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries.filter(ee.Filter.eq("country_na", "United Kingdom"));
Map.centerObject(UK_boundary, 6);

// 2. 导入并过滤 ERA5-Land Hourly 数据（2024年）
var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
            .filterBounds(UK_boundary)
            .filterDate("2024-07-20", "2024-09-20")
            .select("temperature_2m");  // 单位：K

// 3. 将温度从 K 转换为 °C
var era5C = era5.map(function(img) {
  return img
    .subtract(273.15)         // K -> °C
    .rename("tempC")
    .copyProperties(img, img.propertyNames());
});

// 4. 生成二值图像：如果 16°C <= tempC <= 22°C 则为1，否则为0
var flags = era5C.map(function(img) {
  return img
    .gte(16).and(img.lte(22)) // inRange
    .rename("flavorFlag")
    .copyProperties(img, img.propertyNames());
});

// 5. 累加所有小时的 flag，得到累计小时数
var FlavorHours = flags
  .sum()                     // 将一天中所有小时的 0/1 累加
  .clip(UK_boundary)
  .rename("FlavorHours");

// 6. 可视化并打印
Map.addLayer(FlavorHours, {min: 0, max: 1000, palette: ['white','orange']}, "FlavorHours");
print("FlavorHours Image:", FlavorHours);

// （可选）查看区域统计信息
var stats = FlavorHours.reduceRegion({
  reducer: ee.Reducer.minMax().combine({
    reducer2: ee.Reducer.mean(),
    sharedInputs: true
  }).combine({
    reducer2: ee.Reducer.stdDev(),
    sharedInputs: true
  }),
  geometry: UK_boundary,
  scale: 10000,
  maxPixels: 1e9
});
print("FlavorHours stats:", stats);

/***** 基于 FlavorHours 阈值筛选适宜区域 *****/
// 设定阈值，例如 800 小时
var threshold = 800;

// 构建二值掩膜：FlavorHours 在 [threshold, +∞)
var flavorMask = FlavorHours.gte(threshold);
print("FlavorHours Suitability Mask:", flavorMask);

// 将掩膜应用并渲染，仅显示满足条件的区域
Map.addLayer(flavorMask.updateMask(flavorMask), {palette: ['orange']}, 
             "FlavorHours ≥ " + threshold + "h");

/***** 1. 加载并可视化全英国的土壤 pH 值 *****/

// 1.1 定义 UK 边界
var countries = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017");
var UK_boundary = countries
  .filter(ee.Filter.eq('country_na', 'United Kingdom'));

// 1.2 加载 OpenLandMap 土壤 pH（H2O）数据
// band b0 单位为 0.1 pH，除以 10 得到真实 pH
var soilPH = ee.Image("OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02")
  .select('b0')
  .divide(10)
  .rename('soilPH')
  .clip(UK_boundary);

// 1.3 可视化参数：用渐变色显示 pH 4.0–8.0
var visContinuous = {
  min: 4.0,
  max: 8.0,
  palette: [
    '#d7191c', // 酸性（pH≈4）
    '#fdae61', // pH≈5
    '#ffffbf', // pH≈6
    '#abdda4', // pH≈7
    '#2b83ba'  // 碱性（pH≈8）
  ]
};

// 1.4 添加图层
Map.setCenter(-1.5, 52.0, 6);
Map.addLayer(soilPH, visContinuous, 'Soil pH (4–8 Gradient)');

