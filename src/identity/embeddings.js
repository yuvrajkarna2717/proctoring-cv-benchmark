/**
 * Embedding arithmetic for 1:1 verification. Embeddings are L2-normalized by the engine, so the
 * cosine similarity of two embeddings is their dot product. A similarity is a score in [-1, 1],
 * not a probability.
 */

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} dot product; the cosine similarity when both are unit vectors
 */
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new RangeError(`Embedding lengths differ: ${a.length} and ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Cosine similarity of any two non-zero vectors.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function cosineSimilarity(a, b) {
  const norm = Math.sqrt(dot(a, a) * dot(b, b));
  return norm > 0 ? dot(a, b) / norm : NaN;
}

/**
 * Template of several embeddings of one person: the mean vector, normalized to unit length.
 *
 * @param {ArrayLike<number>[]} vectors at least one, all the same length
 * @returns {Float32Array}
 */
export function meanTemplate(vectors) {
  if (vectors.length === 0) throw new RangeError("meanTemplate needs at least one embedding");
  const length = vectors[0].length;
  const sum = new Float64Array(length);
  for (const vector of vectors) {
    if (vector.length !== length) throw new RangeError("Embedding lengths differ");
    for (let i = 0; i < length; i += 1) sum[i] += vector[i];
  }
  const norm = Math.hypot(...sum);
  // Unit vectors that (nearly) cancel leave rounding residue; its direction means nothing.
  if (!(norm > 1e-6 * vectors.length)) {
    throw new RangeError("The embeddings cancel out; no template can be formed");
  }
  return Float32Array.from(sum, (value) => value / norm);
}

/**
 * How closely each sample agrees with the template made from all of them.
 *
 * @param {ArrayLike<number>[]} vectors
 * @param {ArrayLike<number>} template
 */
export function sampleAgreement(vectors, template) {
  const similarities = vectors.map((vector) => dot(vector, template));
  return {
    min: Math.min(...similarities),
    mean: similarities.reduce((sum, value) => sum + value, 0) / similarities.length,
  };
}
