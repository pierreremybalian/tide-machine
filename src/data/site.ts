// Site-wide copy and SEO.
export const SITE = {
  name: 'Block Universe',
  url: 'https://block-universe.balian.dev',
  title: 'Block Universe — Is the future already there? A guided 3D explanation',
  description:
    'Relativity says there is no single “now”. Scroll through 13 stages, built from tested physics, to see why many physicists think past, present and future all exist, and why others disagree.',
  ogImage: '/og.png',
  ogImageAlt: 'Block Universe: two glowing slices of “now” cutting a glass block of spacetime at different angles.',
  themeColor: '#020205',
  author: 'Balian Design',
  /** Google Analytics 4 (the balian.dev property). Loaded in production builds only. */
  gaId: 'G-MXMS8L0Z1H',
  /** Companion piece. */
  cosmicHistory: 'https://cosmic-history.balian.dev',
};

export const STATUS_LABEL = {
  measured: 'Measured',
  established: 'Established',
  argument: 'Argument',
  open: 'Open question',
  metaphor: 'Metaphor',
} as const;

export const STATUS_HELP = {
  measured: 'The effect shown has been measured directly, usually many times, with clocks or particles.',
  established: 'Follows from relativity, which has passed every test so far. Not disputed among physicists.',
  argument: 'A philosophical conclusion drawn from the physics. The premises are stated; you can reject one.',
  open: 'Contested. Physicists and philosophers disagree, and no experiment has decided it.',
  metaphor: 'A picture to help intuition. It does not claim anything literal about the world.',
} as const;

export const CREDITS: { label: string; text: string; url?: string }[] = [
  {
    label: 'Relativity',
    text: 'Every tilt, tick and offset on screen is computed in your browser from special and general relativity (Lorentz transformations, proper time, weak-field clock rates, Schwarzschild geometry). Units and constants: CODATA 2018, IERS, IAU 2015.',
  },
  {
    label: 'Cosmology',
    text: 'Our past light cone uses flat ΛCDM with Planck 2018 parameters (H₀ = 67.4, Ωm = 0.315), the same model as Cosmic History.',
    url: 'https://arxiv.org/abs/1807.06209',
  },
  {
    label: 'Rendering',
    text: 'three.js WebGPU renderer and TSL shaders, Lenis smooth scroll, Astro.',
    url: 'https://threejs.org/',
  },
];
