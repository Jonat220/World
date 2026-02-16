if (window.location.protocol === 'file:') {
  alert('Open this app through a local server (not file://). Use: python3 -m http.server 8080, then open http://localhost:8080');
}

if (!window.L || !window.turf) {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Failed to load map libraries. Check internet access, then refresh.';
  throw new Error('Leaflet/Turf failed to load');
}

let map;
let marker;
let analysisCircle;
let overlayBuildings;
let overlayPavedRoads;
let overlayUnpavedRoads;

let cachedFeatures = {
  buildings: [],
  pavedRoads: [],
  unpavedRoads: []
};

const goToLocationBtn = document.getElementById('goToLocation');
const analyzeBtn = document.getElementById('analyze');
const statusEl = document.getElementById('status');
const radiusInput = document.getElementById('radius');
const unitsInput = document.getElementById('units');
const locationInput = document.getElementById('location');

const showBuildingsInput = document.getElementById('showBuildings');
const showPavedRoadsInput = document.getElementById('showPavedRoads');
const showUnpavedRoadsInput = document.getElementById('showUnpavedRoads');

initializeMap();

locationInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToLocationBtn.click();
  }
});

showBuildingsInput.addEventListener('change', redrawOverlayLayers);
showPavedRoadsInput.addEventListener('change', redrawOverlayLayers);
showUnpavedRoadsInput.addEventListener('change', redrawOverlayLayers);

goToLocationBtn.addEventListener('click', async () => {
  try {
    const location = await resolveLocationInput();
    if (!location) {
      setStatus('Enter an address/coordinates, or click map / drag marker.');
      return;
    }

    const radiusMeters = getRadiusMetersSafe();
    if (!radiusMeters) {
      setStatus('Enter a valid radius greater than 0.');
      return;
    }

    marker.setLatLng([location.lat, location.lng]);
    map.setView([location.lat, location.lng], getZoomLevel(radiusMeters));
    updateAnalysisCircle();
    setStatus(`Moved to ${location.label}. Click Analyze when ready.`);
  } catch (error) {
    setStatus(`Location search failed: ${error.message}`);
  }
});

analyzeBtn.addEventListener('click', async () => {
  try {
    if (!updateAnalysisCircle()) {
      setStatus('Enter a valid radius greater than 0.');
      return;
    }

    const center = marker.getLatLng();
    const radiusMeters = getRadiusMetersSafe();

    setStatus('Fetching OpenStreetMap data...');
    const overpassData = await fetchOverpass(center.lat, center.lng, radiusMeters);

    setStatus('Calculating area metrics...');
    const { metrics, features } = calculateMetricsAndFeatures(overpassData, center.lat, center.lng, radiusMeters);
    cachedFeatures = features;

    renderMetrics(metrics, radiusMeters);
    redrawOverlayLayers();

    setStatus('Analysis complete. Toggle layers to view only buildings/paved/unpaved roads.');
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`);
  }
});

radiusInput.addEventListener('input', updateAnalysisCircle);
unitsInput.addEventListener('change', updateAnalysisCircle);

function initializeMap() {
  map = L.map('map', { center: [0, 0], zoom: 2, zoomControl: true });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics'
  }).addTo(map);

  marker = L.marker([0, 0], { draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const { lat, lng } = marker.getLatLng();
    map.panTo([lat, lng]);
    updateAnalysisCircle();
  });

  analysisCircle = L.circle([0, 0], {
    radius: 1000,
    color: '#4fd1c5',
    fillColor: '#4fd1c5',
    fillOpacity: 0.18,
    weight: 2
  }).addTo(map);

  overlayBuildings = L.layerGroup().addTo(map);
  overlayPavedRoads = L.layerGroup().addTo(map);
  overlayUnpavedRoads = L.layerGroup().addTo(map);

  map.on('click', (event) => {
    marker.setLatLng(event.latlng);
    updateAnalysisCircle();
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        marker.setLatLng([coords.latitude, coords.longitude]);
        map.setView([coords.latitude, coords.longitude], 13);
        updateAnalysisCircle();
      },
      () => updateAnalysisCircle(),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  } else {
    updateAnalysisCircle();
  }
}

function redrawOverlayLayers() {
  overlayBuildings.clearLayers();
  overlayPavedRoads.clearLayers();
  overlayUnpavedRoads.clearLayers();

  if (showBuildingsInput.checked) {
    for (const polygonCoords of cachedFeatures.buildings) {
      L.polygon(polygonCoords, {
        color: '#ffd166',
        weight: 1,
        fillColor: '#ffd166',
        fillOpacity: 0.3
      }).addTo(overlayBuildings);
    }
  }

  if (showPavedRoadsInput.checked) {
    for (const lineCoords of cachedFeatures.pavedRoads) {
      L.polyline(lineCoords, {
        color: '#4fd1c5',
        weight: 3,
        opacity: 0.95
      }).addTo(overlayPavedRoads);
    }
  }

  if (showUnpavedRoadsInput.checked) {
    for (const lineCoords of cachedFeatures.unpavedRoads) {
      L.polyline(lineCoords, {
        color: '#ff6b6b',
        weight: 3,
        opacity: 0.95,
        dashArray: '6 5'
      }).addTo(overlayUnpavedRoads);
    }
  }
}

async function resolveLocationInput() {
  const input = locationInput.value.trim();
  if (!input) return null;

  const coordinateMatch = input.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coordinateMatch) {
    return {
      lat: Number(coordinateMatch[1]),
      lng: Number(coordinateMatch[2]),
      label: 'custom coordinate'
    };
  }

  const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(input)}`;
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });

  if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) throw new Error('location not found');

  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    label: results[0].display_name
  };
}

function getRadiusMetersSafe() {
  const value = Number(radiusInput.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return unitsInput.value === 'mi' ? value * 1609.344 : value * 1000;
}

function updateAnalysisCircle() {
  if (!map || !marker || !analysisCircle) return false;

  const radiusMeters = getRadiusMetersSafe();
  analysisCircle.setLatLng(marker.getLatLng());

  if (!radiusMeters) {
    analyzeBtn.disabled = true;
    return false;
  }

  analyzeBtn.disabled = false;
  analysisCircle.setRadius(radiusMeters);
  return true;
}

async function fetchOverpass(lat, lng, radiusMeters) {
  const radius = Math.round(radiusMeters);
  const query = `
[out:json][timeout:35];
(
  way["building"](around:${radius},${lat},${lng});
  relation["building"](around:${radius},${lat},${lng});
  way["highway"](around:${radius},${lat},${lng});
);
out body;
>;
out skel qt;
  `.trim();

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' }
  });

  if (!response.ok) throw new Error(`Overpass request failed (${response.status})`);
  return response.json();
}

function calculateMetricsAndFeatures(overpassData, lat, lng, radiusMeters) {
  const nodes = new Map();
  const ways = new Map();
  const relations = [];

  for (const element of overpassData.elements || []) {
    if (element.type === 'node') nodes.set(element.id, [element.lon, element.lat]);
    if (element.type === 'way') ways.set(element.id, element);
    if (element.type === 'relation') relations.push(element);
  }

  const center = turf.point([lng, lat]);
  const radiusKm = radiusMeters / 1000;
  const searchAreaSqKm = Math.PI * radiusKm ** 2;

  let buildingCount = 0;
  let roofedAreaSqM = 0;
  let pavedRoadKm = 0;
  let unpavedRoadKm = 0;

  const buildings = [];
  const pavedRoads = [];
  const unpavedRoads = [];

  for (const way of ways.values()) {
    const coords = (way.nodes || []).map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;

    const tags = way.tags || {};

    if (tags.building) {
      const polygonCoords = closeRing(coords);
      if (polygonCoords.length >= 4) {
        const polygon = turf.polygon([polygonCoords]);
        const centroid = turf.centroid(polygon);
        const distanceKm = turf.distance(center, centroid, { units: 'kilometers' });
        if (distanceKm <= radiusKm) {
          buildingCount += 1;
          roofedAreaSqM += turf.area(polygon);
          buildings.push(toLeafletCoords(polygonCoords));
        }
      }
    }

    if (tags.highway) {
      const line = turf.lineString(coords);
      const mid = turf.along(line, turf.length(line, { units: 'kilometers' }) / 2, {
        units: 'kilometers'
      });
      const distanceKm = turf.distance(center, mid, { units: 'kilometers' });
      if (distanceKm > radiusKm) continue;

      const lengthKm = turf.length(line, { units: 'kilometers' });
      const leafletLine = toLeafletCoords(coords);

      if (isPaved(tags.surface)) {
        pavedRoadKm += lengthKm;
        pavedRoads.push(leafletLine);
      } else {
        unpavedRoadKm += lengthKm;
        unpavedRoads.push(leafletLine);
      }
    }
  }

  for (const relation of relations) {
    if (!relation.tags || !relation.tags.building) continue;
    const centerTag = relation.center;
    if (!centerTag) continue;

    const distanceKm = turf.distance(center, turf.point([centerTag.lon, centerTag.lat]), {
      units: 'kilometers'
    });
    if (distanceKm <= radiusKm) buildingCount += 1;
  }

  return {
    metrics: {
      buildingCount,
      buildingDensity: buildingCount / searchAreaSqKm,
      roofedAreaSqM,
      pavedRoadKm,
      unpavedRoadKm
    },
    features: {
      buildings,
      pavedRoads,
      unpavedRoads
    }
  };
}

function toLeafletCoords(coords) {
  return coords.map(([lon, lat]) => [lat, lon]);
}

function closeRing(coords) {
  if (!coords.length) return coords;
  const [firstLon, firstLat] = coords[0];
  const [lastLon, lastLat] = coords[coords.length - 1];
  const closed = [...coords];
  if (firstLon !== lastLon || firstLat !== lastLat) closed.push(coords[0]);
  return closed;
}

function isPaved(surface = '') {
  const pavedSurfaces = new Set([
    'asphalt',
    'concrete',
    'paved',
    'sett',
    'paving_stones',
    'metal',
    'compacted'
  ]);
  if (!surface) return true;
  return pavedSurfaces.has(surface.toLowerCase());
}

function renderMetrics(metrics, radiusMeters) {
  document.getElementById('buildingCount').textContent = metrics.buildingCount.toLocaleString();
  document.getElementById('buildingDensity').textContent = `${metrics.buildingDensity.toFixed(2)} buildings/km²`;
  document.getElementById('roofedArea').textContent = `${metrics.roofedAreaSqM.toLocaleString(undefined, {
    maximumFractionDigits: 0
  })} m² (${((metrics.roofedAreaSqM / (Math.PI * radiusMeters ** 2)) * 100).toFixed(2)}% of circle)`;
  document.getElementById('pavedRoads').textContent = `${metrics.pavedRoadKm.toFixed(2)} km`;
  document.getElementById('unpavedRoads').textContent = `${metrics.unpavedRoadKm.toFixed(2)} km`;
}

function getZoomLevel(radiusMeters) {
  if (radiusMeters <= 200) return 18;
  if (radiusMeters <= 500) return 17;
  if (radiusMeters <= 1000) return 16;
  if (radiusMeters <= 2000) return 15;
  if (radiusMeters <= 5000) return 13;
  if (radiusMeters <= 10000) return 12;
  return 11;
}

function setStatus(message) {
  statusEl.textContent = message;
}
