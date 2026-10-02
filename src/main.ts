import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import kliniken from './data/kliniken.json';

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

// true = Düsseldorf Hbf als Teststandort, false = echtes GPS
const TEST_MODUS = true;
const TEST_STANDORT = { lat: 51.2199, lon: 6.7943 }; // Düsseldorf Hbf

// Adresssuche (Photon, basiert auf OpenStreetMap). Nur Düsseldorf und Umgebung.
const PHOTON_URL = 'https://photon.komoot.io/api/';
const SUCH_BEREICH = '6.60,51.10,7.00,51.40'; // West, Süd, Ost, Nord

// Routenberechnung (öffentlicher OSRM-Demoserver, nur zum Testen gedacht)
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

// Näher als diese Zoomstufe geht die Karte beim Anzeigen einer Route nicht heran
const MAX_ZOOM_ROUTE = 16;

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

type Adresse = {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  country?: string;
};

type Klinik = {
  name: string;
  addr?: Adresse;
  lat: number;
  lon: number;
  notaufnahme: boolean;
  specialities?: string[];
};

type Punkt = { lat: number; lon: number };

// Eine Linie aus [Länge, Breite]-Paaren, so wie OSRM sie liefert
type Linie = { type: 'LineString'; coordinates: [number, number][] };

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [6.7735, 51.2277], // [Länge, Breite] – Düsseldorf
  zoom: 11,
});

// Ebene für die Route anlegen, sobald die Karte geladen ist
map.on('load', () => {
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#c00', 'line-width': 5, 'line-opacity': 0.8 },
  });
});

function zeigeRouteAufKarte(linie: Linie | null) {
  const quelle = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (!quelle) return; // Karte noch nicht fertig geladen
  quelle.setData(
    linie
      ? { type: 'Feature', properties: {}, geometry: linie }
      : { type: 'FeatureCollection', features: [] },
  );
}

// Marker für jede Klinik
for (const k of kliniken as Klinik[]) {
  new maplibregl.Marker({ color: '#c00' })
    .setLngLat([k.lon, k.lat])
    .setPopup(new maplibregl.Popup().setText(k.name))
    .addTo(map);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

// Luftlinie in km (Haversine-Formel)
function entfernungKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Übersetzung der Fachrichtungen für die Anzeige
const FACHRICHTUNGEN: Record<string, string> = {
  cardiac: 'Kardiologie',
  neurological: 'Neurologie',
  pulmonological: 'Pneumologie',
  trauma: 'Unfallchirurgie',
  paediatric: 'Kinderheilkunde',
  obstetric: 'Geburtshilfe',
  burns: 'Verbrennungen',
  psychiatric: 'Psychiatrie',
};

// Baut die Adresszeilen. Leere Teile werden weggelassen.
function formatiereAdresse(addr?: Adresse): string[] {
  if (!addr) return [];
  const zeile1 = [addr.street, addr.housenumber].filter(Boolean).join(' ');
  const zeile2 = [addr.postcode, addr.city].filter(Boolean).join(' ');
  const zeilen = [zeile1, zeile2, addr.country ?? ''];
  return zeilen.filter((z) => z !== '');
}

const hinweis = document.querySelector<HTMLParagraphElement>('#hinweis')!;
function zeigeHinweis(text: string) {
  hinweis.textContent = text;
}

// ---------------------------------------------------------------------------
// Standort
// ---------------------------------------------------------------------------

let standort: Punkt | undefined;
let standortMarker: maplibregl.Marker | undefined;

function setzeStandort(lat: number, lon: number) {
  standort = { lat, lon };
  standortMarker?.remove();
  standortMarker = new maplibregl.Marker({ color: '#06c' })
    .setLngLat([lon, lat])
    .addTo(map);
  map.flyTo({ center: [lon, lat], zoom: 13 });
  zeigeRouteAufKarte(null); // alte Route entfernen
  zeigeNaechste(lat, lon);
}

function bestimmeStandort() {
  zeigeHinweis('');
  if (TEST_MODUS) {
    setzeStandort(TEST_STANDORT.lat, TEST_STANDORT.lon);
    return;
  }
  if (!('geolocation' in navigator)) {
    zeigeHinweis('Dein Browser kann keinen Standort bestimmen. Bitte gib eine Adresse ein.');
    adressFeld.focus();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setzeStandort(pos.coords.latitude, pos.coords.longitude),
    () => {
      zeigeHinweis('Standort nicht verfügbar oder nicht erlaubt. Bitte gib eine Adresse ein.');
      adressFeld.focus();
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

document.querySelector('#locate')!.addEventListener('click', bestimmeStandort);

// ---------------------------------------------------------------------------
// Adresssuche mit Vorschlägen
// ---------------------------------------------------------------------------

const adressFeld = document.querySelector<HTMLInputElement>('#adresse')!;
const vorschlagsListe = document.querySelector<HTMLUListElement>('#vorschlaege')!;

type PhotonErgebnis = {
  geometry: { coordinates: [number, number] }; // [Länge, Breite]
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
  };
};

// Macht aus einem Suchergebnis einen lesbaren Text
function beschrifteErgebnis(p: PhotonErgebnis['properties']): string {
  const strasse = [p.street, p.housenumber].filter(Boolean).join(' ');
  const ort = [p.postcode, p.city].filter(Boolean).join(' ');
  // Bei Orten wie "Hauptbahnhof" steht der Name in "name", sonst die Straße
  const erster = p.name && p.name !== p.street ? p.name : strasse;
  return [erster, erster === strasse ? '' : strasse, ort].filter(Boolean).join(', ');
}

let suchTimer: number | undefined;
let letzteSuche = 0;

adressFeld.addEventListener('input', () => {
  // Erst suchen, wenn 400 ms lang nichts mehr getippt wurde (schont den Server)
  window.clearTimeout(suchTimer);
  const text = adressFeld.value.trim();
  if (text.length < 3) {
    vorschlagsListe.hidden = true;
    return;
  }
  suchTimer = window.setTimeout(() => sucheAdresse(text), 400);
});

async function sucheAdresse(text: string) {
  const dieseSuche = ++letzteSuche;
  const url = `${PHOTON_URL}?q=${encodeURIComponent(text)}&lang=de&limit=5&bbox=${SUCH_BEREICH}`;
  try {
    const antwort = await fetch(url);
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    const daten: { features: PhotonErgebnis[] } = await antwort.json();
    // Eine ältere Suche, die später ankommt, wird ignoriert
    if (dieseSuche !== letzteSuche) return;
    zeigeVorschlaege(daten.features);
  } catch {
    zeigeHinweis('Die Adresssuche ist gerade nicht erreichbar.');
  }
}

function zeigeVorschlaege(ergebnisse: PhotonErgebnis[]) {
  vorschlagsListe.innerHTML = '';
  for (const e of ergebnisse) {
    const li = document.createElement('li');
    li.textContent = beschrifteErgebnis(e.properties);
    li.addEventListener('click', () => {
      const [lon, lat] = e.geometry.coordinates;
      adressFeld.value = li.textContent ?? '';
      vorschlagsListe.hidden = true;
      zeigeHinweis('');
      setzeStandort(lat, lon);
    });
    vorschlagsListe.appendChild(li);
  }
  vorschlagsListe.hidden = ergebnisse.length === 0;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

type Route = { linie: Linie; minuten: number; km: number };

async function holeRoute(start: Punkt, ziel: Punkt): Promise<Route> {
  const url = `${OSRM_URL}${start.lon},${start.lat};${ziel.lon},${ziel.lat}?overview=full&geometries=geojson`;
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  const daten = await antwort.json();
  const route = daten.routes?.[0];
  if (!route) throw new Error('Keine Route gefunden');
  return {
    linie: route.geometry,
    minuten: Math.round(route.duration / 60),
    km: route.distance / 1000,
  };
}

// Kartenausschnitt so wählen, dass Start und Ziel beide gut sichtbar sind.
// fitBounds legt die beiden Punkte an gegenüberliegende Ränder bzw. Ecken.
function zeigeStartUndZiel(start: Punkt, ziel: Punkt) {
  const bereich = new maplibregl.LngLatBounds([start.lon, start.lat], [start.lon, start.lat]);
  bereich.extend([ziel.lon, ziel.lat]);
  map.fitBounds(bereich, { padding: 60, maxZoom: MAX_ZOOM_ROUTE, duration: 800 });
}

// ---------------------------------------------------------------------------
// Klinikliste
// ---------------------------------------------------------------------------

let letzteAuswahl = 0;

async function waehleKlinik(li: HTMLLIElement, k: Klinik) {
  if (!standort) return;
  const start = standort;

  // Markierung: nur der angeklickte Eintrag ist ausgewählt
  document.querySelectorAll('.klinik.ausgewaehlt').forEach((el) => el.classList.remove('ausgewaehlt'));
  li.classList.add('ausgewaehlt');

  zeigeStartUndZiel(start, k);

  const fahrzeit = li.querySelector<HTMLDivElement>('.fahrzeit')!;
  fahrzeit.textContent = 'Route wird berechnet …';

  const dieseAuswahl = ++letzteAuswahl;
  try {
    const route = await holeRoute(start, k);
    if (dieseAuswahl !== letzteAuswahl) return; // inzwischen andere Klinik gewählt
    zeigeRouteAufKarte(route.linie);
    fahrzeit.textContent = `ca. ${route.minuten} min, ${route.km.toFixed(1)} km Fahrstrecke (ohne Sonderrechte)`;
  } catch {
    if (dieseAuswahl !== letzteAuswahl) return;
    fahrzeit.textContent = 'Route konnte nicht berechnet werden.';
  }
}

function zeigeNaechste(lat: number, lon: number) {
  const sortiert = (kliniken as Klinik[])
    .filter((k) => k.notaufnahme)
    .map((k) => ({ ...k, km: entfernungKm(lat, lon, k.lat, k.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);

  const liste = document.querySelector<HTMLOListElement>('#list')!;
  liste.innerHTML = '';
  for (const k of sortiert) {
    const li = document.createElement('li');
    li.className = 'klinik';
    li.tabIndex = 0; // mit Tab-Taste erreichbar

    const titel = document.createElement('strong');
    titel.textContent = `${k.name} – ${k.km.toFixed(1)} km Luftlinie`;
    li.appendChild(titel);

    const adresse = formatiereAdresse(k.addr);
    if (adresse.length > 0) {
      const div = document.createElement('div');
      div.className = 'adresse';
      // Jede Zeile einzeln, getrennt durch einen Zeilenumbruch
      adresse.forEach((zeile, i) => {
        if (i > 0) div.appendChild(document.createElement('br'));
        div.appendChild(document.createTextNode(zeile));
      });
      li.appendChild(div);
    }

    if (k.specialities && k.specialities.length > 0) {
      const div = document.createElement('div');
      div.className = 'fachrichtungen';
      const namen = k.specialities.map((s) => FACHRICHTUNGEN[s] ?? s);
      div.textContent = 'Fachrichtungen: ' + namen.join(', ');
      li.appendChild(div);
    }

    // Platz für die Fahrzeit, wird nach der Auswahl gefüllt
    const fahrzeit = document.createElement('div');
    fahrzeit.className = 'fahrzeit';
    li.appendChild(fahrzeit);

    li.addEventListener('click', () => waehleKlinik(li, k));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        waehleKlinik(li, k);
      }
    });

    liste.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Start: Standort direkt beim Öffnen der Seite bestimmen
// ---------------------------------------------------------------------------

bestimmeStandort();