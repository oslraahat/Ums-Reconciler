"use strict";
/* a small fixed-size parallel pool: run `worker(item, i)` over `items`, `size` at a time */

async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

module.exports = { pool: pool };
