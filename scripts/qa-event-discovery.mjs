import assert from "node:assert/strict";
import {
  classifyEventDiscoveryBatch,
  EVENT_DISCOVERY_BATCH_LIMIT,
  EventDiscoveryProviderError,
} from "../lib/ai/classify-event-discovery.ts";

const expectedGenres = [
  "electronic", "house", "techno", "trance", "drum-and-bass", "disco-funk", "pop", "rock", "indie-alternative", "metal-punk",
  "hip-hop", "rnb-soul", "jazz-blues", "folk", "classical", "latin", "afro-amapiano", "reggae-dub", "ambient", "etno-world",
];
const claim = (label, source, quote) => ({ label, source, quote });
const row = (index, claims = {}) => ({ row: index, p: null, c: [], f: [], g: [], r: [], ...claims });
const mockResponse = (rows) => Response.json({
  id: "response-fixture",
  model: "fixture-model-2026-11-07",
  status: "completed",
  output: [{ content: [{ type: "output_text", text: JSON.stringify({ rows }) }] }],
  usage: { input_tokens: 73, output_tokens: 44, total_tokens: 117 },
});
const options = { apiKey: "test-only-key", model: "fixture-model" };

const inputs = [
  {
    key: "internal-event-one", title: "Noć u Fabrici", description: "Elektronska muzika za ples.",
    occurrenceText: "6.11. – Večera i DJ set uz house i techno. Program vodi Ana Marković.",
    venue: "Test Club", artists: ["DJ Mina"],
  },
  {
    key: "internal-event-two", title: "Jazz Foxes", artists: ["Jazz Foxes"], venue: "Pop House",
    description: "Jazz Foxes band performs at Pop House. Concert begins at 21:00.",
  },
  {
    key: "internal-event-three", title: "Rock pub quiz", description: "Rock-themed pub quiz.",
    artists: ["Rina"],
  },
  {
    key: "internal-event-four", title: "Night 2", occurrenceText: "7.11. – Rina plays.",
  },
  {
    key: "internal-event-five", title: "Jazz Foxes", artists: ["Jazz Foxes"],
    description: "Jazz Foxes play jazz and blues in concert.",
  },
];
const responseRows = [
  row(1, {
    p: claim("live", "description", "Concert begins at 21:00"),
    f: [claim("concert", "description", "Concert begins at 21:00")],
    g: [claim("jazz-blues", "description", "Jazz"), claim("jazz-blues", "description", "Jazz Foxes band performs"),
      claim("pop", "description", "at Pop House"), claim("house", "description", "Pop House")],
  }),
  row(0, {
    p: claim("party", "occurrenceText", "DJ set uz house i techno"),
    c: [claim("food", "occurrenceText", "Večera"), claim("exhibition", "occurrenceText", "Večera")],
    f: [claim("dj-set", "occurrenceText", "DJ set"), claim("dinner", "occurrenceText", "Večera"), claim("screening", "occurrenceText", "DJ set")],
    g: [claim("house", "occurrenceText", "house i techno"), claim("techno", "occurrenceText", "house i techno"),
      claim("electronic", "description", "Elektronska muzika"), claim("reggae-dub", "occurrenceText", "house i techno"),
      claim("progressive-house", "occurrenceText", "house i techno")],
    r: [
      { name: "DJ Mina", role: "dj", source: "artists", quote: "DJ Mina" },
      { name: "DJ Mina", role: "organizer", source: "artists", quote: "DJ Mina" },
      { name: "Ana Marković", role: "presenter", source: "occurrenceText", quote: "Program vodi Ana Marković" },
      { name: "Ana Marković", role: "guest", source: "occurrenceText", quote: "Program vodi Ana Marković" },
    ],
  }),
  row(4, {
    p: claim("live", "description", "in concert"),
    g: [claim("jazz-blues", "description", "play jazz and blues")],
  }),
  row(2, {
    p: claim("participate", "description", "pub quiz"),
    f: [claim("quiz", "description", "pub quiz")],
    g: [claim("rock", "description", "Rock-themed pub quiz")],
    r: [{ name: "Rina", role: "guest", source: "artists", quote: "Rina" }],
  }),
  row(3, {
    p: claim("party", "occurrenceText", "DJ set uz house i techno"),
    f: [claim("dj-set", "occurrenceText", "DJ set"), claim("concert", "title", "Night 2 concert")],
    g: [claim("house", "occurrenceText", "house i techno")],
    r: [
      { name: "Ana Marković", role: "presenter", source: "occurrenceText", quote: "Program vodi Ana Marković" },
      { name: "Rina", role: "performer", source: "occurrenceText", quote: "Rina PLAYS" },
    ],
  }),
];

let boundaryCalls = 0;
const result = await classifyEventDiscoveryBatch(inputs, {
  ...options,
  beforeTransport: async () => { boundaryCalls++; },
  fetch: async (url, request) => {
    assert.equal(boundaryCalls, 1, "The provider boundary runs once before the request.");
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(request.method, "POST");
    assert.equal(request.cache, "no-store");
    const body = JSON.parse(request.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.properties.rows.items.properties.g.items.properties.label.enum, expectedGenres);
    const { rows } = JSON.parse(body.input.find(({ role }) => role === "user").content);
    assert.deepEqual(rows.map(({ row }) => row), [0, 1, 2, 3, 4]);
    assert.ok(rows.every((entry) => !Object.hasOwn(entry, "key")), "Send row numbers to the provider instead of internal event IDs.");
    assert.ok(inputs.every(({ key }) => !request.body.includes(key)));
    return mockResponse(responseRows);
  },
});
assert.deepEqual(result.results.map(({ key }) => key), inputs.map(({ key }) => key), "Provider row order must not change input identity.");
assert.equal(result.model, "fixture-model-2026-11-07");
assert.deepEqual(result.usage, { inputTokens: 73, outputTokens: 44, totalTokens: 117 });
assert.equal(result.attempts, 1);
assert.equal(result.responseId, "response-fixture");

const [hybrid, namedOnly, quiz, wrongOccurrence, explicitJazz] = result.results;
assert.deepEqual(hybrid.taxonomy, {
  primaryCategory: "party", categories: ["party", "food"], formats: ["dj-set", "dinner"], genres: ["house", "techno"],
});
assert.deepEqual(hybrid.credits, [
  { name: "DJ Mina", role: "dj", source: "artists", quote: "DJ Mina" },
  { name: "Ana Marković", role: "presenter", source: "occurrenceText", quote: "Program vodi Ana Marković" },
]);
assert.ok(hybrid.evidence.some(({ kind, label, source, quote }) => kind === "category" && label === "food" && source === "occurrenceText" && quote === "Večera"));
assert.equal(namedOnly.taxonomy.primaryCategory, "live");
assert.deepEqual(namedOnly.taxonomy.genres, [], "Genre words embedded only in a performer or venue name never become event genres.");
assert.equal(namedOnly.discardedClaims, 4);
assert.deepEqual(quiz.taxonomy, { primaryCategory: "participate", categories: ["participate"], formats: ["quiz"], genres: [] });
assert.deepEqual(quiz.credits, [], "An existing artist name cannot prove guest billing.");
assert.deepEqual(wrongOccurrence, { key: inputs[3].key, taxonomy: null, credits: [], evidence: [], discardedClaims: 6 },
  "Adjacent occurrence evidence and non-verbatim quotes must be discarded.");
assert.deepEqual(explicitJazz.taxonomy.genres, ["jazz-blues"], "Independent programming evidence survives a genre word in the artist's name.");

assert.equal(EVENT_DISCOVERY_BATCH_LIMIT, 20);
const maxInputs = Array.from({ length: EVENT_DISCOVERY_BATCH_LIMIT }, (_, key) => ({ key, title: "Unclassified listing" }));
const maxBatch = await classifyEventDiscoveryBatch(maxInputs, { ...options, fetch: async () => mockResponse(maxInputs.map((_, index) => row(index))) });
assert.equal(maxBatch.results.length, 20);
const neverTransport = () => assert.fail("Invalid batch inputs must stop before transport.");
for (const invalid of [[], [...maxInputs, { key: 20, title: "Extra" }], [inputs[0], inputs[0]]]) {
  await assert.rejects(classifyEventDiscoveryBatch(invalid, { ...options, beforeTransport: neverTransport, fetch: neverTransport }), /distinct rows/);
}
for (const invalid of [[row(0)], [row(0), row(0)], [row(0), row(2)], [row(0), row("1")], [row(0), row(1), row(2)]]) {
  await assert.rejects(
    classifyEventDiscoveryBatch(inputs.slice(0, 2), { ...options, fetch: async () => mockResponse(invalid) }),
    (error) => error instanceof EventDiscoveryProviderError && error.code === "invalid output row coverage" && error.attempts === 1,
    "Malformed row coverage must invalidate the batch before any result can be written.",
  );
}

console.log("Event discovery QA passed: transport, exact occurrence evidence, 20 genre labels, credits, abstentions and strict row coverage.");
