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
const OSRM_TABLE_URL = 'https://router.project-osrm.org/table/v1/driving/';

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
  zeigeKliniken(lat, lon);
}

function bestimmeStandort() {
  zeigeHinweis('');
  if (TEST_MODUS) {
    setzeStandort(TEST_STANDORT.lat, TEST_STANDORT.lon);
    return;
  }
  if (!('geolocation' in navigator)) {
    zeigeHinweis('Dein Browser kann keinen Standort bestimmen. Bitte gib die Adresse ein.');
    plzFeld.focus();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setzeStandort(pos.coords.latitude, pos.coords.longitude),
    () => {
      zeigeHinweis('Standort nicht verfügbar oder nicht erlaubt. Bitte gib die Adresse ein.');
      plzFeld.focus();
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

document.querySelector('#locate')!.addEventListener('click', bestimmeStandort);

// ---------------------------------------------------------------------------
// Adresseingabe: PLZ, Stadt, Straße, Hausnummer
// ---------------------------------------------------------------------------

const plzFeld = document.querySelector<HTMLInputElement>('#plz')!;
const stadtFeld = document.querySelector<HTMLInputElement>('#stadt')!;
const strassenFeld = document.querySelector<HTMLInputElement>('#strasse')!;
const nummerFeld = document.querySelector<HTMLInputElement>('#hausnummer')!;
const adressFormular = document.querySelector<HTMLFormElement>('#adressform')!;
const vorschlagsListe = document.querySelector<HTMLUListElement>('#vorschlaege')!;

// Postleitzahlen in und um Düsseldorf. Bei Bedarf einfach erweitern.
const PLZ_ORTE: Record<string, string> = {
  '40667': 'Meerbusch', '40668': 'Meerbusch', '40670': 'Meerbusch',
  '40699': 'Erkrath',
  '40721': 'Hilden', '40723': 'Hilden', '40724': 'Hilden',
  '40878': 'Ratingen', '40880': 'Ratingen', '40882': 'Ratingen', '40883': 'Ratingen', '40885': 'Ratingen',
  '41460': 'Neuss', '41462': 'Neuss', '41464': 'Neuss', '41466': 'Neuss',
  '41468': 'Neuss', '41469': 'Neuss', '41470': 'Neuss', '41472': 'Neuss',
};

function ortZurPlz(plz: string): string | undefined {
  const zahl = Number(plz);
  if (zahl >= 40210 && zahl <= 40629) return 'Düsseldorf'; // alle Düsseldorfer PLZ
  return PLZ_ORTE[plz];
}

// Merkt sich, ob die Stadt automatisch eingetragen wurde.
// Eine selbst eingetippte Stadt wird nie überschrieben.
let stadtAutomatisch = false;

plzFeld.addEventListener('input', () => {
  const plz = plzFeld.value.trim();
  if (plz.length !== 5) return;
  const ort = ortZurPlz(plz);
  if (ort && (stadtFeld.value === '' || stadtAutomatisch)) {
    stadtFeld.value = ort;
    stadtAutomatisch = true;
    strassenFeld.focus(); // weiter zur Straße
  }
});

stadtFeld.addEventListener('input', () => {
  stadtAutomatisch = false;
});

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

async function photonSuche(text: string, extra = ''): Promise<PhotonErgebnis[]> {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(text)}&lang=de&limit=10&bbox=${SUCH_BEREICH}${extra}`;
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  const daten: { features: PhotonErgebnis[] } = await antwort.json();
  return daten.features;
}

// --- Straßenvorschläge, passend zur gewählten Stadt ---

let suchTimer: number | undefined;
let letzteSuche = 0;

strassenFeld.addEventListener('input', () => {
  // Erst suchen, wenn 400 ms lang nichts mehr getippt wurde (schont den Server)
  window.clearTimeout(suchTimer);
  const text = strassenFeld.value.trim();
  if (text.length < 3) {
    vorschlagsListe.hidden = true;
    return;
  }
  suchTimer = window.setTimeout(() => sucheStrassen(text), 400);
});

async function sucheStrassen(text: string) {
  const dieseSuche = ++letzteSuche;
  const stadt = stadtFeld.value.trim();
  try {
    // osm_tag=highway: nur Straßen, keine Geschäfte oder Haltestellen
    const ergebnisse = await photonSuche(`${text} ${stadt}`, '&osm_tag=highway');
    if (dieseSuche !== letzteSuche) return; // ältere Suche ignorieren

    // Nur Straßen aus der gewählten Stadt, jeden Namen nur einmal
    const namen = new Set<string>();
    for (const e of ergebnisse) {
      const name = e.properties.name;
      if (!name) continue;
      if (stadt && e.properties.city && e.properties.city !== stadt) continue;
      namen.add(name);
    }
    zeigeStrassenVorschlaege([...namen].slice(0, 6));
  } catch {
    zeigeHinweis('Die Adresssuche ist gerade nicht erreichbar.');
  }
}

function zeigeStrassenVorschlaege(namen: string[]) {
  vorschlagsListe.innerHTML = '';
  for (const name of namen) {
    const li = document.createElement('li');
    li.textContent = name;
    li.addEventListener('click', () => {
      strassenFeld.value = name;
      vorschlagsListe.hidden = true;
      nummerFeld.focus(); // weiter zur Hausnummer
    });
    vorschlagsListe.appendChild(li);
  }
  vorschlagsListe.hidden = namen.length === 0;
}

// --- Adresse übernehmen (Knopf "Suchen" oder Enter) ---

adressFormular.addEventListener('submit', async (e) => {
  e.preventDefault(); // sonst lädt der Browser die Seite neu
  vorschlagsListe.hidden = true;
  const plz = plzFeld.value.trim();
  const stadt = stadtFeld.value.trim();
  const strasse = strassenFeld.value.trim();
  const nummer = nummerFeld.value.trim();
  if (!strasse || (!plz && !stadt)) {
    zeigeHinweis('Bitte mindestens Straße und PLZ oder Stadt angeben.');
    return;
  }
  zeigeHinweis('');
  try {
    const ergebnisse = await photonSuche(`${strasse} ${nummer}, ${plz} ${stadt}`);
    const treffer = ergebnisse[0];
    if (!treffer) {
      zeigeHinweis('Adresse nicht gefunden.');
      return;
    }
    if (nummer && treffer.properties.housenumber !== nummer) {
      zeigeHinweis('Hausnummer nicht gefunden, es wird die Straße verwendet.');
    }
    const [lon, lat] = treffer.geometry.coordinates;
    setzeStandort(lat, lon);
  } catch {
    zeigeHinweis('Die Adresssuche ist gerade nicht erreichbar.');
  }
});

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

type Fahrzeit = { minuten: number; km: number };

// Fahrzeiten vom Start zu mehreren Zielen mit einer Anfrage (OSRM "table").
// Liefert pro Ziel ein Ergebnis oder null, falls keine Route gefunden wurde.
async function holeFahrzeiten(start: Punkt, ziele: Punkt[]): Promise<(Fahrzeit | null)[]> {
  const punkte = [start, ...ziele].map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${OSRM_TABLE_URL}${punkte}?sources=0&annotations=duration,distance`;
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  const daten = await antwort.json();
  const dauer: (number | null)[] = daten.durations[0];
  const strecke: (number | null)[] = daten.distances[0];
  // Index 0 ist der Start selbst, die Ziele beginnen bei 1
  return ziele.map((_, i) => {
    const sek = dauer[i + 1];
    const meter = strecke[i + 1];
    return sek == null || meter == null ? null : { minuten: Math.round(sek / 60), km: meter / 1000 };
  });
}

// Kartenausschnitt so wählen, dass Start und Ziel beide gut sichtbar sind.
// fitBounds legt die beiden Punkte an gegenüberliegende Ränder bzw. Ecken.
function zeigeStartUndZiel(start: Punkt, ziel: Punkt) {
  const bereich = new maplibregl.LngLatBounds([start.lon, start.lat], [start.lon, start.lat]);
  bereich.extend([ziel.lon, ziel.lat]);
  map.fitBounds(bereich, { padding: 60, maxZoom: MAX_ZOOM_ROUTE, duration: 800 });
}

// Kartenausschnitt so wählen, dass die ganze Route sichtbar ist.
// Die Route kann einen Bogen machen und dabei über Start und Ziel hinausgehen.
function zeigeGanzeRoute(linie: Linie) {
  const [erster, ...rest] = linie.coordinates;
  const bereich = new maplibregl.LngLatBounds(erster, erster);
  for (const punkt of rest) bereich.extend(punkt);
  map.fitBounds(bereich, { padding: 60, maxZoom: MAX_ZOOM_ROUTE, duration: 800 });
}

// ---------------------------------------------------------------------------
// Klinikliste und Auswahlliste
// ---------------------------------------------------------------------------

// Ein Listeneintrag: die Klinik, ihr <li>-Element und die Werte zum Sortieren
type Eintrag = {
  klinik: Klinik;
  li: HTMLLIElement;
  luftlinieKm: number;
  minuten?: number; // Fahrzeit, sobald bekannt
};

const liste = document.querySelector<HTMLOListElement>('#list')!;
const klinikWahl = document.querySelector<HTMLSelectElement>('#klinikwahl')!;

let eintraege: Eintrag[] = [];
let letzteListe = 0;
let letzteAuswahl = 0;

// Auswahlliste einmalig mit allen Kliniken füllen (alphabetisch)
const alleKliniken = kliniken as Klinik[];
[...alleKliniken]
  .sort((a, b) => a.name.localeCompare(b.name, 'de'))
  .forEach((k) => {
    const option = document.createElement('option');
    option.value = String(alleKliniken.indexOf(k)); // Position in kliniken.json
    option.textContent = k.name;
    klinikWahl.appendChild(option);
  });

klinikWahl.addEventListener('change', () => {
  if (klinikWahl.value === '') return;
  const k = alleKliniken[Number(klinikWahl.value)];
  const eintrag = eintraege.find((e) => e.klinik === k);
  if (!eintrag) {
    zeigeHinweis('Bitte zuerst den Standort bestimmen oder eine Adresse eingeben.');
    klinikWahl.value = '';
    return;
  }
  eintrag.li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  waehleKlinik(eintrag);
});

async function waehleKlinik(eintrag: Eintrag) {
  if (!standort) return;
  const start = standort;
  const k = eintrag.klinik;

  // Markierung: nur dieser Eintrag ist ausgewählt
  document.querySelectorAll('.klinik.ausgewaehlt').forEach((el) => el.classList.remove('ausgewaehlt'));
  eintrag.li.classList.add('ausgewaehlt');
  wendeFilterAn(); // vorher ausgewählte Klinik ggf. wieder ausblenden
  klinikWahl.value = String(alleKliniken.indexOf(k)); // Auswahlliste mitziehen

  zeigeStartUndZiel(start, k);

  const dieseAuswahl = ++letzteAuswahl;
  try {
    const route = await holeRoute(start, k);
    if (dieseAuswahl !== letzteAuswahl) return; // inzwischen andere Klinik gewählt
    zeigeRouteAufKarte(route.linie);
    zeigeGanzeRoute(route.linie);
  } catch {
    if (dieseAuswahl !== letzteAuswahl) return;
    zeigeHinweis('Die Route konnte nicht berechnet werden.');
  }
}

// Baut das <li> für eine Klinik
function baueEintrag(k: Klinik, luftlinieKm: number): Eintrag {
  const li = document.createElement('li');
  li.className = 'klinik';
  li.tabIndex = 0; // mit Tab-Taste erreichbar

  const titel = document.createElement('strong');
  titel.textContent = k.name;
  li.appendChild(titel);

  // Fahrzeit und Entfernung, wird gefüllt, sobald die Fahrzeiten da sind
  const fahrzeit = document.createElement('div');
  fahrzeit.className = 'fahrzeit';
  fahrzeit.textContent = `Fahrzeit wird berechnet … (${luftlinieKm.toFixed(1)} km Luftlinie)`;
  li.appendChild(fahrzeit);

  if (!k.notaufnahme) {
    const div = document.createElement('div');
    div.className = 'warnung';
    div.textContent = 'Keine Notaufnahme';
    li.appendChild(div);
  }

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

  const eintrag: Eintrag = { klinik: k, li, luftlinieKm };
  li.addEventListener('click', () => waehleKlinik(eintrag));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      waehleKlinik(eintrag);
    }
  });
  return eintrag;
}

async function zeigeKliniken(lat: number, lon: number) {
  const dieseListe = ++letzteListe;
  klinikWahl.value = '';

  // 1. Sofort alle Kliniken nach Luftlinie anzeigen
  eintraege = alleKliniken
    .map((k) => baueEintrag(k, entfernungKm(lat, lon, k.lat, k.lon)))
    .sort((a, b) => a.luftlinieKm - b.luftlinieKm);
  liste.innerHTML = '';
  eintraege.forEach((e) => liste.appendChild(e.li));
  wendeFilterAn();

  // 2. Fahrzeiten zu allen Kliniken mit einer einzigen Anfrage holen
  try {
    const ergebnisse = await holeFahrzeiten({ lat, lon }, eintraege.map((e) => e.klinik));
    if (dieseListe !== letzteListe) return; // Standort hat sich inzwischen geändert

    eintraege.forEach((e, i) => {
      const r = ergebnisse[i];
      const fahrzeit = e.li.querySelector<HTMLDivElement>('.fahrzeit')!;
      if (r) {
        e.minuten = r.minuten;
        fahrzeit.textContent = `ca. ${r.minuten} min, ${r.km.toFixed(1)} km Fahrstrecke`;
      } else {
        fahrzeit.textContent = `Keine Route gefunden (${e.luftlinieKm.toFixed(1)} km Luftlinie)`;
      }
    });

    // 3. Nach Fahrzeit neu sortieren. Kliniken ohne Fahrzeit kommen ans Ende.
    eintraege.sort((a, b) => (a.minuten ?? Infinity) - (b.minuten ?? Infinity));
    eintraege.forEach((e) => liste.appendChild(e.li)); // appendChild verschiebt vorhandene Elemente
  } catch {
    if (dieseListe !== letzteListe) return;
    zeigeHinweis('Fahrzeiten konnten nicht berechnet werden. Die Liste ist nach Luftlinie sortiert.');
    eintraege.forEach((e) => {
      e.li.querySelector('.fahrzeit')!.textContent = `${e.luftlinieKm.toFixed(1)} km Luftlinie`;
    });
  }
}

// ---------------------------------------------------------------------------
// Filter nach Fachrichtungen
// ---------------------------------------------------------------------------

const filterBereich = document.querySelector<HTMLDivElement>('#filter')!;
const keinTreffer = document.querySelector<HTMLParagraphElement>('#keintreffer')!;
const aktiveFachrichtungen = new Set<string>();

// Alle Fachrichtungen, die in kliniken.json vorkommen, sortiert nach deutschem Namen
const vorhandeneFachrichtungen = [...new Set(alleKliniken.flatMap((k) => k.specialities ?? []))].sort(
  (a, b) => (FACHRICHTUNGEN[a] ?? a).localeCompare(FACHRICHTUNGEN[b] ?? b, 'de'),
);

for (const code of vorhandeneFachrichtungen) {
  const knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'schalter';
  knopf.textContent = FACHRICHTUNGEN[code] ?? code;
  knopf.setAttribute('aria-pressed', 'false'); // Standard: aus
  knopf.addEventListener('click', () => {
    const an = !aktiveFachrichtungen.has(code);
    if (an) aktiveFachrichtungen.add(code);
    else aktiveFachrichtungen.delete(code);
    knopf.setAttribute('aria-pressed', String(an));
    wendeFilterAn();
  });
  filterBereich.appendChild(knopf);
}

// Blendet Kliniken aus, die nicht ALLE eingeschalteten Fachrichtungen haben.
// Die ausgewählte Klinik bleibt immer sichtbar.
function wendeFilterAn() {
  let sichtbar = 0;
  for (const e of eintraege) {
    const hat = e.klinik.specialities ?? [];
    const passt = [...aktiveFachrichtungen].every((f) => hat.includes(f));
    e.li.hidden = !passt && !e.li.classList.contains('ausgewaehlt');
    if (!e.li.hidden) sichtbar++;
  }
  keinTreffer.hidden = !(eintraege.length > 0 && sichtbar === 0);
}

// ---------------------------------------------------------------------------
// Start: Standort direkt beim Öffnen der Seite bestimmen
// ---------------------------------------------------------------------------

bestimmeStandort();