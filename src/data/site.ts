// Site-wide copy and SEO.
export const SITE = {
  name: 'Tide Machine',
  url: 'https://tide-machine.balian.dev',
  title: 'Tide Machine — How the tides work, and the brass computer that predicted them',
  description:
    'Watch the tide sweep into San Francisco Bay, see why the Moon and Sun make it, then build Kelvin’s tide-predicting machine and use it on any coast on Earth. Every water level is computed from real NOAA data.',
  ogImage: '/og.png',
  ogImageAlt: 'Tide Machine: San Francisco Bay at low tide beside a brass machine of pulleys drawing the tide curve.',
  themeColor: '#020306',
  author: 'Balian Design',
  /** Google Analytics 4 (the balian.dev property). Loaded in production builds only. */
  gaId: 'G-MXMS8L0Z1H',
  /** Companion pieces. */
  cosmicHistory: 'https://cosmic-history.balian.dev',
  blockUniverse: 'https://block-universe.balian.dev',
};

export const STATUS_LABEL = {
  measured: 'Measured',
  established: 'Established',
  historical: 'Historical',
  simplified: 'Simplified',
  modelled: 'Modeled',
  metaphor: 'Metaphor',
} as const;

export const STATUS_HELP = {
  measured: 'Water levels, constants and records come from tide gauges; predictions are computed from them and checked against NOAA’s.',
  established: 'Standard physics of the tides, not in dispute.',
  historical: 'Documented history of the tide-predicting machines.',
  simplified: 'A schematic model that is right in kind but leaves out detail, such as the idealized bulges.',
  modelled: 'From a global ocean tide model where no gauge exists; good at sea, coarser inside bays and estuaries.',
  metaphor: 'A picture to help intuition; it claims nothing literal.',
} as const;

export const CREDITS: { label: string; text: string; url?: string }[] = [
  {
    label: 'Tide data',
    text: 'NOAA Center for Operational Oceanographic Products and Services (CO-OPS): harmonic constants, datums, observations and official predictions. US government work, public domain.',
    url: 'https://tidesandcurrents.noaa.gov/',
  },
  {
    label: 'Global tide model',
    text: 'EOT20, Hart-Davis et al. 2021, Earth System Science Data 13, 3869. CC BY 4.0.',
    url: 'https://doi.org/10.17882/79489',
  },
  {
    label: 'Terrain and bathymetry',
    text: 'AWS Open Data Terrain Tiles (Mapzen/Tilezen), compiled from NOAA Coastal Relief Model, ETOPO1, GEBCO, SRTM and others.',
    url: 'https://registry.opendata.aws/terrain-tiles/',
  },
  {
    label: 'Method',
    text: 'Harmonic prediction after Schureman (1958), Manual of Harmonic Analysis and Prediction of Tides, US Coast and Geodetic Survey Special Publication 98.',
  },
  {
    label: 'Rendering',
    text: 'three.js WebGPU renderer and TSL shaders, Lenis smooth scroll, Astro.',
    url: 'https://threejs.org/',
  },
];
