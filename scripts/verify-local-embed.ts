import { FastembedProvider, Embedder, buildProvider } from '../src/ingest/embed.ts';

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const provider = new FastembedProvider();
const embedder = new Embedder(provider);

const texts = [
  'how do I fix a failing database migration',
  'the migration script errored on the postgres schema',
  'best pizza toppings for a summer barbecue',
];

const t0 = Date.now();
const vecs = await embedder.embed(texts);
console.log(`provider model=${provider.model} dim=${provider.dim} (embedded in ${Date.now() - t0}ms)`);
console.log(`vectors: ${vecs.length} x ${vecs[0]!.length}`);

const related = cos(vecs[0]!, vecs[1]!);
const unrelated = cos(vecs[0]!, vecs[2]!);
console.log(`cosine(related migration pair)   = ${related.toFixed(4)}`);
console.log(`cosine(migration vs pizza)        = ${unrelated.toFixed(4)}`);
console.log(related > unrelated ? 'PASS: related > unrelated' : 'FAIL: related <= unrelated');

// Fallback latch: openai with no key must produce local vectors + one warning.
const fb = buildProvider({ embeddingProvider: 'openai', openaiApiKey: '', embeddingModel: 'text-embedding-3-small', embeddingDim: 1536 });
const fbVec = await fb.embed(['keyless fallback should latch to local']);
console.log(`fallback provider model=${fb.model} dim=${fb.dim} vecLen=${fbVec[0]!.length}`);
console.log(fb.model === 'all-MiniLM-L6-v2' && fbVec[0]!.length === 384 ? 'PASS: keyless fallback latched to local' : 'FAIL: fallback did not latch');
