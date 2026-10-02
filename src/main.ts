import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import kliniken from './data/kliniken.json';

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

// true = Düsseldorf Hbf als Teststandort, false = echtes GPS
const TEST_MODUS = false;
const TEST_STANDORT = { lat: 51.2199, lon: 6.7943 }; // Düsseldorf Hbf

// Adresssuche (Photon, basiert auf OpenStreetMap). Nur Düsseldorf und Umgebung.
const PHOTON_URL = 'https://photon.komoot.io/api/';
const SUCH_BEREICH = '6.60,51.10,7.00,51.40'; // West, Süd, Ost, Nord

// Routenberechnung (öffentlicher OSRM-Demoserver, nur zum Testen gedacht)
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const OSRM_TABLE_URL = 'https://router.project-osrm.org/table/v1/driving/';

// Google Maps "Maps URLs": öffnet eine Route, ohne API-Schlüssel
const GOOGLE_MAPS_URL = 'https://www.google.com/maps/dir/';
const GOOGLE_HINWEIS =
  'Hinweis: Diese Funktion darf laut Dienstanweisung NICHT für oder in Einsätzen verwendet werden.\n\n' +
  'Sie dient nur zum Abgleich zwischen der Fahrzeit in RettNav und der Fahrzeit nach aktueller Verkehrslage.\n\n' +
  'Google Maps startet am aktuellen Standort des Handys. Weiter zu Google Maps?';

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
  // Kam die Route schon an, bevor die Karte fertig war? Dann jetzt zeichnen.
  zeigeRouteAufKarte(aktuelleLinie);
});

// Die zuletzt berechnete Route. Wird gemerkt, damit sie auch dann gezeichnet
// wird, wenn sie schneller da ist als die Karte (z. B. direkt beim Öffnen).
let aktuelleLinie: Linie | null = null;

function zeigeRouteAufKarte(linie: Linie | null) {
  aktuelleLinie = linie;
  const quelle = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (!quelle) return; // Karte noch nicht fertig, der 'load'-Handler holt das nach
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
    zeigeAdressfelder();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setzeStandort(pos.coords.latitude, pos.coords.longitude),
    () => {
      zeigeHinweis('Standort nicht verfügbar oder nicht erlaubt. Bitte gib die Adresse ein.');
      zeigeAdressfelder();
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
const adressKnopf = document.querySelector<HTMLButtonElement>('#adressknopf')!;

// Die Adressfelder sind zuerst versteckt und erscheinen erst auf Knopfdruck
let adressfelderOffen = false;

function zeigeAdressfelder(sichtbar = true) {
  adressfelderOffen = sichtbar;
  adressFormular.hidden = !sichtbar;
  adressKnopf.setAttribute('aria-expanded', String(sichtbar));
  if (sichtbar) plzFeld.focus();
  map.resize(); // der Platz für die Karte hat sich geändert
}

adressKnopf.addEventListener('click', () => {
  zeigeAdressfelder(!adressfelderOffen); // versteckt → zeigen, sichtbar → verstecken
});

// Vergleicht zwei Texte ohne Rücksicht auf Groß-/Kleinschreibung:
// "düsseldorf" ist gleich "Düsseldorf", aber "Dusseldorf" bleibt verschieden.
function gleicherText(a: string, b: string): boolean {
  return a.localeCompare(b, 'de', { sensitivity: 'accent' }) === 0;
}

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
      if (stadt && e.properties.city && !gleicherText(e.properties.city, stadt)) continue;
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
    // Ohne PLZ suchen: Lange Straßen haben mehrere PLZ, und eine falsche PLZ
    // führt sonst zum falschen Abschnitt. Die Stadt kommt ja schon aus der PLZ.
    const ergebnisse = await photonSuche(`${strasse} ${nummer}, ${stadt || plz}`);
    if (ergebnisse.length === 0) {
      zeigeHinweis('Adresse nicht gefunden.');
      return;
    }

    // Alle Treffer mit genau dieser Hausnummer (Groß-/Kleinschreibung egal, z. B. "5a")
    const mitNummer = ergebnisse.filter(
      (e) => nummer !== '' && gleicherText(e.properties.housenumber ?? '', nummer),
    );
    // Am liebsten der Treffer mit der eingegebenen PLZ, sonst der erste mit Hausnummer,
    // sonst irgendein Treffer (dann nur die Straße)
    const treffer =
      mitNummer.find((e) => e.properties.postcode === plz) ?? mitNummer[0] ?? ergebnisse[0];

    if (nummer && mitNummer.length === 0) {
      zeigeHinweis('Hausnummer nicht gefunden, es wird die Straße verwendet.');
    } else if (mitNummer.length > 0 && treffer.properties.postcode && treffer.properties.postcode !== plz) {
      plzFeld.value = treffer.properties.postcode; // richtige PLZ eintragen
      // Nur melden, wenn vorher eine (falsche) PLZ drinstand, nicht bei leerem Feld
      if (plz) zeigeHinweis(`PLZ korrigiert auf ${treffer.properties.postcode}.`);
    }
    // Richtige Schreibweise übernehmen, z. B. "moorenstraße" → "Moorenstraße"
    strassenFeld.value = treffer.properties.street ?? treffer.properties.name ?? strasse;
    const trefferStadt = treffer.properties.city;
    if (trefferStadt && gleicherText(trefferStadt, stadt)) stadtFeld.value = trefferStadt;

    const [lon, lat] = treffer.geometry.coordinates;
    setzeStandort(lat, lon);
  } catch {
    zeigeHinweis('Die Adresssuche ist gerade nicht erreichbar.');
  }
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

// Ein Abschnitt der Route, so wie OSRM ihn mit "steps=true" liefert
type Schritt = {
  name: string; // Straßenname, kann leer sein
  ref?: string; // Straßennummer, z. B. "B 8"
  distance: number; // Meter, die man auf diesem Abschnitt fährt
  maneuver: { type: string; modifier?: string; exit?: number };
};

type Route = { linie: Linie; minuten: number; km: number; schritte: Schritt[] };

async function holeRoute(start: Punkt, ziel: Punkt): Promise<Route> {
  // steps=true: zusätzlich die Abbiegeschritte für die Wegbeschreibung
  const url = `${OSRM_URL}${start.lon},${start.lat};${ziel.lon},${ziel.lat}?overview=full&geometries=geojson&steps=true`;
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  const daten = await antwort.json();
  const route = daten.routes?.[0];
  if (!route) throw new Error('Keine Route gefunden');
  return {
    linie: route.geometry,
    minuten: Math.round(route.duration / 60),
    km: route.distance / 1000,
    schritte: route.legs?.[0]?.steps ?? [],
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
  // Liegt die Wegbeschreibung unten über der Karte (gesperrt), unten mehr Abstand lassen
  const unten = document.body.classList.contains('gesperrt') && wegAnsichtOffen ? seite.offsetHeight + 30 : 60;
  map.fitBounds(bereich, {
    padding: { top: 60, right: 60, left: 60, bottom: unten },
    maxZoom: MAX_ZOOM_ROUTE,
    duration: 800,
  });
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
  km?: number; // Fahrstrecke, sobald bekannt
  schritte?: Schritt[]; // Abbiegeschritte, sobald die Route da ist
};

const liste = document.querySelector<HTMLOListElement>('#list')!;
const klinikWahl = document.querySelector<HTMLSelectElement>('#klinikwahl')!;

let eintraege: Eintrag[] = [];
let ausgewaehlt: Eintrag | undefined; // die aktuell ausgewählte Klinik
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
  waehleKlinik(eintrag, true);
});

// ausDropdown = true nur, wenn die Klinik über die Auswahlliste gewählt wurde.
// Bei jeder anderen Auswahl (Liste, automatisch) springt die Liste zurück.
async function waehleKlinik(eintrag: Eintrag, ausDropdown = false) {
  if (!standort) return;
  const start = standort;
  const k = eintrag.klinik;

  // Markierung: nur dieser Eintrag ist ausgewählt
  document.querySelectorAll('.klinik.ausgewaehlt').forEach((el) => el.classList.remove('ausgewaehlt'));
  eintrag.li.classList.add('ausgewaehlt');
  ausgewaehlt = eintrag;
  wendeFilterAn(); // vorher ausgewählte Klinik ggf. wieder ausblenden
  zeigeAuswahlInfo();
  klinikWahl.value = ausDropdown ? String(alleKliniken.indexOf(k)) : '';

  zeigeStartUndZiel(start, k);

  const dieseAuswahl = ++letzteAuswahl;
  try {
    const route = await holeRoute(start, k);
    if (dieseAuswahl !== letzteAuswahl) return; // inzwischen andere Klinik gewählt
    zeigeRouteAufKarte(route.linie);
    zeigeGanzeRoute(route.linie);
    // Fahrzeit der Route übernehmen (falls die Tabelle noch fehlt)
    eintrag.minuten = route.minuten;
    eintrag.km = route.km;
    eintrag.schritte = route.schritte;
    if (wegAnsichtOffen) zeigeWegbeschreibung(); // offene Beschreibung aktualisieren
    eintrag.li.querySelector('.fahrzeit')!.textContent = `ca. ${route.minuten} min, ${route.km.toFixed(1)} km Fahrstrecke`;
    zeigeAuswahlInfo();
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

  // 🌍 rechts oben: Route bei Google Maps (Start = aktueller Standort des Handys)
  const google = document.createElement('a');
  google.className = 'googlelink';
  google.textContent = '🌍';
  google.title = 'Fahrzeit bei Google Maps vergleichen';
  google.href = `${GOOGLE_MAPS_URL}?api=1&destination=${k.lat},${k.lon}&travelmode=driving`;
  google.target = '_blank'; // in neuem Tab bzw. in der Google-Maps-App öffnen
  google.rel = 'noopener';
  google.addEventListener('click', (e) => {
    e.stopPropagation(); // Klinik nicht neu auswählen
    if (!confirm(GOOGLE_HINWEIS)) e.preventDefault(); // "Abbrechen" → Link nicht öffnen
  });
  li.appendChild(google);

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

  // "Route"-Knopf. Per CSS nur sichtbar, wenn Study an ist und die Klinik ausgewählt ist.
  const routeKnopf = document.createElement('button');
  routeKnopf.type = 'button';
  routeKnopf.className = 'routeknopf';
  routeKnopf.textContent = 'Route';
  routeKnopf.addEventListener('click', (e) => {
    e.stopPropagation(); // sonst würde der Klick auch beim <li> ankommen
    oeffneWegbeschreibung();
  });
  li.appendChild(routeKnopf);

  const eintrag: Eintrag = { klinik: k, li, luftlinieKm };
  li.addEventListener('click', () => waehleKlinik(eintrag));
  li.addEventListener('keydown', (e) => {
    if (e.target !== li) return; // Tasten auf dem Route-Knopf nicht abfangen
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
  ausgewaehlt = undefined;

  // 1. Sofort alle Kliniken nach Luftlinie anzeigen
  eintraege = alleKliniken
    .map((k) => baueEintrag(k, entfernungKm(lat, lon, k.lat, k.lon)))
    .sort((a, b) => a.luftlinieKm - b.luftlinieKm);
  liste.innerHTML = '';
  eintraege.forEach((e) => liste.appendChild(e.li));
  wendeFilterAn();
  zeigeAuswahlInfo();

  // 2. Fahrzeiten zu allen Kliniken mit einer einzigen Anfrage holen
  try {
    const ergebnisse = await holeFahrzeiten({ lat, lon }, eintraege.map((e) => e.klinik));
    if (dieseListe !== letzteListe) return; // Standort hat sich inzwischen geändert

    eintraege.forEach((e, i) => {
      const r = ergebnisse[i];
      const fahrzeit = e.li.querySelector<HTMLDivElement>('.fahrzeit')!;
      if (r) {
        e.minuten = r.minuten;
        e.km = r.km;
        fahrzeit.textContent = `ca. ${r.minuten} min, ${r.km.toFixed(1)} km Fahrstrecke`;
      } else {
        fahrzeit.textContent = `Keine Route gefunden (${e.luftlinieKm.toFixed(1)} km Luftlinie)`;
      }
    });

    // 3. Nach Fahrzeit neu sortieren. Kliniken ohne Fahrzeit kommen ans Ende.
    eintraege.sort((a, b) => (a.minuten ?? Infinity) - (b.minuten ?? Infinity));
    eintraege.forEach((e) => liste.appendChild(e.li)); // appendChild verschiebt vorhandene Elemente
    // Gleich die schnellste (passende) Klinik auswählen
    waehleNaechstePassende();
  } catch {
    if (dieseListe !== letzteListe) return;
    zeigeHinweis('Fahrzeiten konnten nicht berechnet werden. Die Liste ist nach Luftlinie sortiert.');
    eintraege.forEach((e) => {
      e.li.querySelector('.fahrzeit')!.textContent = `${e.luftlinieKm.toFixed(1)} km Luftlinie`;
    });
    waehleNaechstePassende();
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
    waehleNaechstePassende();
  });
  filterBereich.appendChild(knopf);
}

// Blendet Kliniken aus, die nicht ALLE eingeschalteten Fachrichtungen haben.
// Die ausgewählte Klinik bleibt immer sichtbar.
// Hat die Klinik ALLE eingeschalteten Fachrichtungen?
function passtZumFilter(k: Klinik): boolean {
  const hat = k.specialities ?? [];
  return [...aktiveFachrichtungen].every((f) => hat.includes(f));
}

function wendeFilterAn() {
  let sichtbar = 0;
  for (const e of eintraege) {
    const passt = passtZumFilter(e.klinik);
    e.li.hidden = !passt && !e.li.classList.contains('ausgewaehlt');
    if (!e.li.hidden) sichtbar++;
  }
  keinTreffer.hidden = !(eintraege.length > 0 && sichtbar === 0);
}

// Nach jeder Filteränderung: die schnellste passende Klinik auswählen.
// "eintraege" ist bereits nach Fahrzeit sortiert, der erste Treffer ist also der nächste.
function waehleNaechstePassende() {
  if (eintraege.length === 0) {
    zeigeAuswahlInfo(); // noch kein Standort, nur die Fachrichtungen aktualisieren
    return;
  }
  const passend = eintraege.find((e) => passtZumFilter(e.klinik));
  if (passend) {
    passend.li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    waehleKlinik(passend);
    return;
  }
  // Keine Klinik passt: Auswahl und Route entfernen
  schliesseWegbeschreibung();
  ausgewaehlt = undefined;
  letzteAuswahl++; // laufende Routenanfrage ignorieren
  document.querySelectorAll('.klinik.ausgewaehlt').forEach((el) => el.classList.remove('ausgewaehlt'));
  klinikWahl.value = '';
  zeigeRouteAufKarte(null);
  wendeFilterAn();
  zeigeAuswahlInfo();
}

// ---------------------------------------------------------------------------
// Infozeile über der Karte
// ---------------------------------------------------------------------------

const auswahlInfo = document.querySelector<HTMLDivElement>('#auswahlinfo')!;

function zeigeAuswahlInfo() {
  auswahlInfo.innerHTML = '';

  const ziel = document.createElement('div');
  ziel.className = 'ziel';
  if (ausgewaehlt) {
    const e = ausgewaehlt;
    const zeit =
      e.minuten !== undefined && e.km !== undefined
        ? `ca. ${e.minuten} min, ${e.km.toFixed(1)} km`
        : 'Fahrzeit wird berechnet …';
    ziel.textContent = `Ziel: ${e.klinik.name} – ${zeit}`;
  } else if (eintraege.length > 0 && !eintraege.some((e) => passtZumFilter(e.klinik))) {
    // Nur melden, wenn wirklich keine Klinik passt
    ziel.textContent = 'Keine Klinik hat alle gewählten Fachrichtungen.';
  } else {
    ziel.textContent = 'Noch keine Klinik ausgewählt';
  }
  auswahlInfo.appendChild(ziel);

  const fach = document.createElement('div');
  const namen = [...aktiveFachrichtungen].map((f) => FACHRICHTUNGEN[f] ?? f);
  fach.textContent = 'Benötigte Fachrichtungen: ' + (namen.length > 0 ? namen.join(', ') : 'keine');
  auswahlInfo.appendChild(fach);
}

// ---------------------------------------------------------------------------
// Study-Modus: Wegbeschreibung Straße für Straße
// ---------------------------------------------------------------------------

const studyKnopf = document.querySelector<HTMLButtonElement>('#study')!;
const seite = document.querySelector<HTMLElement>('#seite')!;
const wegTitel = document.querySelector<HTMLElement>('#wegtitel')!;
const wegListe = document.querySelector<HTMLOListElement>('#wegliste')!;
let wegAnsichtOffen = false;

studyKnopf.addEventListener('click', () => {
  const an = !document.body.classList.contains('study');
  document.body.classList.toggle('study', an); // CSS zeigt dann den Route-Knopf
  studyKnopf.setAttribute('aria-pressed', String(an));
  if (!an) schliesseWegbeschreibung();
});

document.querySelector('#wegzurueck')!.addEventListener('click', schliesseWegbeschreibung);

function oeffneWegbeschreibung() {
  wegAnsichtOffen = true;
  document.body.classList.add('wegansicht'); // CSS blendet die Klinikliste aus
  seite.scrollTop = 0;
  zeigeWegbeschreibung();
}

function schliesseWegbeschreibung() {
  wegAnsichtOffen = false;
  document.body.classList.remove('wegansicht');
  ausgewaehlt?.li.scrollIntoView({ block: 'nearest' });
}

function zeigeWegbeschreibung() {
  wegListe.innerHTML = '';
  if (!ausgewaehlt) return;
  wegTitel.textContent = `Route zu ${ausgewaehlt.klinik.name}`;
  const schritte = ausgewaehlt.schritte;
  if (!schritte) {
    wegListe.appendChild(document.createElement('li')).textContent = 'Route wird berechnet …';
    return;
  }
  for (const text of baueAnweisungen(schritte, ausgewaehlt.klinik.name)) {
    wegListe.appendChild(document.createElement('li')).textContent = text;
  }
}

// --- Aus den OSRM-Schritten deutsche Sätze bauen ---

// Meter lesbar machen: "450 m" oder "1,2 km"
function formatiereStrecke(meter: number): string {
  if (meter < 1000) return `${Math.max(10, Math.round(meter / 10) * 10)} m`;
  return `${(meter / 1000).toFixed(1).replace('.', ',')} km`;
}

const RICHTUNGEN: Record<string, string> = {
  left: 'links',
  right: 'rechts',
  'slight left': 'halb links',
  'slight right': 'halb rechts',
  'sharp left': 'scharf links',
  'sharp right': 'scharf rechts',
  straight: 'geradeaus',
  uturn: 'wenden',
};

// Artikel aus der Endung raten: "die ...straße", "den ...weg", "das ...ufer".
// Passt nichts (z. B. "Am Wehrhahn"), steht der Name ohne Artikel in Anführungszeichen.
function geschlecht(name: string): 'f' | 'm' | 'n' | undefined {
  const n = name.toLowerCase();
  if (/^(am|an|auf|im|in|zum|zur|unter|hinter|vor) /.test(n)) return undefined;
  if (/^[abkl] ?\d/.test(n)) return 'f'; // "die A 46", "die B 8"
  if (/(straße|strasse|str\.|allee|gasse|chaussee|promenade|brücke|bahn|spange)$/.test(n)) return 'f';
  if (/(weg|platz|ring|damm|wall|graben|steig|pfad|markt|tunnel|zubringer|kanal)$/.test(n)) return 'm';
  if (/(ufer|tor|feld)$/.test(n)) return 'n';
  return undefined;
}

// "von der Kölner Straße", "vom Graf-Adolf-Platz", "von „Am Wehrhahn“".
// Ein leerer Name steht für eine Straße ohne Namen.
function von(name: string): string {
  if (!name) return 'von einer unbenannten Straße';
  const g = geschlecht(name);
  if (g === 'f') return `von der ${name}`;
  if (g) return `vom ${name}`;
  return `von „${name}“`;
}

// "auf die Kölner Straße", "auf den Graf-Adolf-Platz", "auf das Rheinufer"
function auf(name: string): string {
  if (!name) return 'auf eine unbenannte Straße';
  const g = geschlecht(name);
  if (g === 'f') return `auf die ${name}`;
  if (g === 'm') return `auf den ${name}`;
  if (g === 'n') return `auf das ${name}`;
  return `auf „${name}“`;
}

// "auf der Kölner Straße", "auf dem Graf-Adolf-Platz" (wo man gerade ist)
function aufDer(name: string): string {
  if (!name) return 'auf einer unbenannten Straße';
  const g = geschlecht(name);
  if (g === 'f') return `auf der ${name}`;
  if (g) return `auf dem ${name}`;
  return `auf „${name}“`;
}

// Straßenname oder Straßennummer, leer bei Wegen ohne Namen (Hof, Parkplatz …)
function strassenName(s: Schritt): string {
  return s.name || s.ref || '';
}

function baueAnweisungen(schritte: Schritt[], ziel: string): string[] {
  const saetze: string[] = [];
  let bisher = ''; // Straße, auf der man gerade fährt
  let gefahren = 0; // Meter seit der letzten Anweisung
  let amStart = true; // noch auf Wegen ohne Namen rund um die Einsatzstelle

  for (const s of schritte) {
    const art = s.maneuver.type;
    const richtung = RICHTUNGEN[s.maneuver.modifier ?? ''] ?? '';
    const abbiegen = richtung !== '' && richtung !== 'geradeaus' && richtung !== 'wenden';
    const name = strassenName(s);
    const nach = `nach ${formatiereStrecke(gefahren)}`;

    if (art === 'arrive') {
      saetze.push(`Nach ${formatiereStrecke(gefahren)} ist das Ziel erreicht: ${ziel}.`);
      break;
    }

    if (art === 'depart') {
      if (name) {
        saetze.push(`Starte ${aufDer(name)}.`);
        amStart = false;
      }
      bisher = name;
      gefahren = s.distance;
      continue;
    }

    // Start ohne Straßennamen: erst bei der ersten richtigen Straße eine Anweisung
    if (amStart) {
      if (!name) {
        gefahren += s.distance; // weiter auf Wegen ohne Namen
        continue;
      }
      const wohin = abbiegen ? `nach ${richtung} ${auf(name)}` : `in Richtung ${name}`;
      const strecke = gefahren >= 100 ? ` (${nach})` : ''; // kurze Wege nicht erwähnen
      saetze.push(`Verlasse die Einsatzstelle ${wohin}${strecke}.`);
      amStart = false;
    } else if (art === 'roundabout' || art === 'rotary') {
      const ausfahrt = s.maneuver.exit ? `die ${s.maneuver.exit}. Ausfahrt` : 'die Ausfahrt';
      saetze.push(`Fahre ${nach} ${von(bisher)} in den Kreisverkehr und nimm ${ausfahrt} ${auf(name)}.`);
    } else if (name === bisher) {
      // Gleiche Straße: nur abbiegen oder wenden ist eine eigene Anweisung wert
      if (abbiegen && name) {
        saetze.push(`Bleibe ${aufDer(name)}, indem du ${nach} ${richtung} abbiegst.`);
      } else if (abbiegen) {
        saetze.push(`Biege ${nach} ${richtung} ab.`);
      } else if (richtung === 'wenden') {
        saetze.push(`Wende ${nach} ${aufDer(bisher)}.`);
      } else {
        gefahren += s.distance; // geradeaus weiter: Strecke einfach weiterzählen
        continue;
      }
    } else if (richtung === 'wenden') {
      saetze.push(`Wende ${nach} ${aufDer(bisher)}.`);
    } else if (!abbiegen) {
      saetze.push(`Fahre ${nach} ${von(bisher)} geradeaus weiter ${auf(name)}.`);
    } else {
      saetze.push(`Biege ${nach} ${von(bisher)} ${richtung} ${auf(name)} ab.`);
    }
    bisher = name;
    gefahren = s.distance; // die Strecke dieses Abschnitts zählt bis zur nächsten Anweisung
  }
  return saetze;
}

// ---------------------------------------------------------------------------
// Sperre: blockiert alle anderen Eingaben, bis sie wieder gelöst wird
// ---------------------------------------------------------------------------

const sperrKnopf = document.querySelector<HTMLButtonElement>('#sperre')!;
// "inert" macht ein Element samt Inhalt unbedienbar: kein Klick, kein Tippen,
// kein Fokus mit der Tab-Taste. Der Sperr-Knopf selbst gehört nicht dazu.
const sperrBereiche = document.querySelectorAll<HTMLElement>(
  '#study, #locate, #adressknopf, #adressform, #klinikwahl, #filter, #map, #list',
);
let gesperrt = false;

sperrKnopf.addEventListener('click', () => {
  gesperrt = !gesperrt;
  sperrBereiche.forEach((el) => (el.inert = gesperrt));
  // Die Klasse "gesperrt" blendet per CSS alles außer Karte und Infozeile aus
  document.body.classList.toggle('gesperrt', gesperrt);
  // Die Karte ist jetzt größer bzw. kleiner: neu ausmessen, Route wieder einpassen
  map.resize();
  if (aktuelleLinie) zeigeGanzeRoute(aktuelleLinie);
  sperrKnopf.setAttribute('aria-pressed', String(gesperrt));
  sperrKnopf.textContent = gesperrt ? '🔒 Entsperren' : '🔓 Sperren';
});

// ---------------------------------------------------------------------------
// Start: Standort direkt beim Öffnen der Seite bestimmen
// ---------------------------------------------------------------------------

bestimmeStandort();