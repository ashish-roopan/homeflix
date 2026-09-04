'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TmdbClient, similarity } = require('../src/main/services/tmdb');

// A client whose search() answers from a table keyed by the lower-cased query.
function fakeClient(table) {
  const c = new TmdbClient(() => 'key');
  c.calls = [];
  c.search = async (query, year) => {
    c.calls.push([query, year]);
    return (table[query.toLowerCase()] || []).map((r) => ({ originalTitle: r.title, popularity: 10, posterPath: '/p.jpg', overview: '', rating: 7, backdropPath: null, ...r }));
  };
  return c;
}

test('similarity', () => {
  assert.equal(similarity('Captain Philips', 'Captain Phillips') > 0.9, true);
  assert.equal(similarity('Love Actuallly', 'Love Actually') > 0.9, true);
  assert.equal(similarity('Sillu Karuppatty', 'Sillu Karupatti') > 0.85, true);
  assert.equal(similarity('Mookuthy Amman', 'Mookuthi Amman') > 0.9, true);
  assert.equal(similarity('Captain Philips', 'Captain America') < 0.8, true);
  assert.equal(similarity('', 'x'), 0);
});

test('findBest: exact search still wins without fuzzy searches', async () => {
  const c = fakeClient({ 'the matrix': [{ id: 603, title: 'The Matrix', year: 1999 }] });
  const hit = await c.findBest('The Matrix', 1999);
  assert.equal(hit.id, 603);
  assert.equal(c.calls.length, 1);
});

test('findBest: a misspelt title is found through a distinctive word and a near-identical result', async () => {
  const c = fakeClient({
    captain: [
      { id: 1, title: 'Captain America', year: 2011 },
      { id: 2, title: 'Captain Phillips', year: 2013 },
    ],
  });
  const hit = await c.findBest('Captain Philips', 2013);
  assert.equal(hit.id, 2);
});

test('findBest: fuzzy fallback never accepts a merely related title', async () => {
  const c = fakeClient({ totally: [{ id: 9, title: 'Total Recall', year: 1990 }] });
  assert.equal(await c.findBest('Totally Unknown Film', 2010), null);
  assert.ok(c.calls.length <= 8, 'bounded number of searches');
});

test('findBest: original title counts too', async () => {
  const c = fakeClient({ sillu: [{ id: 5, title: 'Sillu Karupatti', originalTitle: 'சில்லு கருப்பட்டி', year: 2019 }] });
  const hit = await c.findBest('sillu karuppatty', null);
  assert.equal(hit.id, 5);
});
