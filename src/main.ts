import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import kliniken from './data/kliniken.json';

maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [6.7735, 51.2277], // [Länge, Breite] – Düsseldorf
  zoom: 11,
});

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

// Marker für jede Klinik
for (const k of kliniken as Klinik[]) {
  new maplibregl.Marker({ color: '#c00' })
    .setLngLat([k.lon, k.lat])
    .setPopup(new maplibregl.Popup().setText(k.name))
    .addTo(map);
}

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

    liste.appendChild(li);
  }
}

// true = Düsseldorf Hbf als Teststandort, false = echtes GPS
const TEST_MODUS = true;
const TEST_STANDORT = { lat: 51.2199, lon: 6.7943 }; // Düsseldorf Hbf

let standortMarker: maplibregl.Marker | undefined;

function setzeStandort(lat: number, lon: number) {
  standortMarker?.remove();
  standortMarker = new maplibregl.Marker({ color: '#06c' })
    .setLngLat([lon, lat])
    .addTo(map);
  map.flyTo({ center: [lon, lat], zoom: 13 });
  zeigeNaechste(lat, lon);
}

document.querySelector('#locate')!.addEventListener('click', () => {
  if (TEST_MODUS) {
    setzeStandort(TEST_STANDORT.lat, TEST_STANDORT.lon);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setzeStandort(pos.coords.latitude, pos.coords.longitude),
    (err) => alert('Standort nicht verfügbar: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});