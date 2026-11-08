// Unicode superscripts (⁻³⁶) are outside our fonts' subsets and fall back to a system font, which looks broken
// in monospace. Convert runs of them to <sup> with ordinary digits. Input is escaped; output is safe HTML.

const SUP: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '−',
  '⁺': '+',
};
const RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function supHtml(text: string): string {
  return escape(text).replace(RUN, (m) => `<sup>${[...m].map((c) => SUP[c] ?? c).join('')}</sup>`);
}

/** Plain-text version for aria labels: "10⁻³⁶ s" → "10 to the power −36 s". */
export function supText(text: string): string {
  return text.replace(RUN, (m) => ` to the power ${[...m].map((c) => SUP[c] ?? c).join('')}`);
}
