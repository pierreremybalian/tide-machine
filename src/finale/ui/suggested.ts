// The finale's suggested places (HANDOFF §10; the brief's list): a point on the water at each, so the tide source and
// the terrain land where the tide is. Four have NOAA stations within 25 km (measured), the rest use EOT20 (modelled).

export interface Suggested {
  id: string;
  name: string;
  sub: string;
  lat: number;
  lng: number;
}

export const SUGGESTED: readonly Suggested[] = [
  { id: 'sf', name: 'San Francisco', sub: 'Golden Gate, California', lat: 37.8063, lng: -122.4659 },
  { id: 'eastport', name: 'Eastport', sub: 'Maine', lat: 44.9046, lng: -66.9829 },
  { id: 'fundy', name: 'Bay of Fundy', sub: 'Minas Basin, Nova Scotia', lat: 45.32, lng: -64.05 },
  { id: 'venice', name: 'Venice', sub: 'Lido inlet, Italy', lat: 45.418, lng: 12.43 },
  { id: 'rio', name: 'Rio de Janeiro', sub: 'Guanabara Bay, Brazil', lat: -22.93, lng: -43.15 },
  { id: 'sydney', name: 'Sydney', sub: 'Port Jackson, Australia', lat: -33.84, lng: 151.27 },
  { id: 'capetown', name: 'Cape Town', sub: 'Table Bay, South Africa', lat: -33.9, lng: 18.43 },
  { id: 'msm', name: 'Mont-Saint-Michel', sub: 'Normandy, France', lat: 48.66, lng: -1.56 },
  { id: 'honolulu', name: 'Honolulu', sub: 'Oʻahu, Hawaii', lat: 21.3067, lng: -157.867 },
  { id: 'tokyo', name: 'Tokyo Bay', sub: 'Japan', lat: 35.5, lng: 139.82 },
];
