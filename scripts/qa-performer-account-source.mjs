import assert from "node:assert/strict";
import {
  instagramAccountFacts,
  directoryAccountFacts,
  researchPerformerAccount,
} from "../lib/ai/research-performer-account.ts";
const handle = "test.band";
const ig = "https://www.instagram.com/test.band/";
const directory = "https://ra.co/dj/test-band/biography";
const html = (bio, account = handle) =>
  `<meta content="Test Band (@${account}) • Instagram photos and videos" property="og:title"><meta content='500 followers, 12 posts - Test Band (@${account}) on Instagram: "${bio}"' name="description">`;
const card = (sameAs, genres) =>
  `<script type="application/ld+json">${JSON.stringify({ "@type": "ProfilePage", mainEntity: { "@type": "Person", name: "Test Band", sameAs, knowsAbout: genres } })}</script>`;
const text = (body) =>
  new Response(body, { headers: { "content-type": "text/html" } });
const keys = (facts) => facts.genres.map((x) => x.genre).sort();
assert.deepEqual(
  keys(instagramAccountFacts(handle, html("pop / rock / disco / funk"))),
  ["disco-funk", "pop", "rock"],
);
assert.deepEqual(
  instagramAccountFacts(handle, html("pop band", "test.band2")),
  { handle, genres: [] },
);
for (const bio of [
  "Singer in @mytechno",
  "DJ at Beach House",
  "DJ / not a techno producer",
  "booking: techno",
  "inspired by house music",
  "music photographer at opera house",
])
  assert.deepEqual(keys(instagramAccountFacts(handle, html(bio))), [], bio);
assert.equal(
  directoryAccountFacts(handle, directory, card([ig + "other"], ["House"])),
  undefined,
);
assert.deepEqual(
  keys(
    directoryAccountFacts(
      handle,
      directory,
      card([ig], ["Liquid Funk", "Dub Techno", "Drum'n'Bass"]),
    ),
  ),
  ["drum-and-bass", "techno"],
);
let calls = 0,
  reserved = 0;
const fromIg = await researchPerformerAccount({
  handle,
  internetSearch: true,
  beforeInternetSearch: async () => {
    reserved++;
  },
  fetch: async (url) => {
    assert.equal(url, ig);
    calls++;
    return text(html("Drum and Bass DJ"));
  },
});
assert.deepEqual(
  [calls, reserved, fromIg.displayName.value, ...keys(fromIg)],
  [1, 0, "Test Band", "drum-and-bass"],
);
const evidence = "Test Band is a house music duo.";
const prevKey = process.env.OPENAI_API_KEY,
  prevModel = process.env.OPENAI_REVIEW_MODEL;
process.env.OPENAI_API_KEY = "test-artist-key";
process.env.OPENAI_REVIEW_MODEL = "fixture-model";
try {
  async function find(
    page,
    source = directory,
    cited = true,
    paid = true,
    bio = "live sets",
    quoted = evidence,
  ) {
    let spend = 0,
      transmitted = 0;
    const facts = await researchPerformerAccount({
      handle,
      internetSearch: paid,
      beforeInternetSearch: async () => {
        spend++;
      },
      fetch: async (value, init) => {
        if (value === ig) return text(html(bio));
        if (value.startsWith("https://djs.rs/")) return text("");
        if (value === "https://api.openai.com/v1/responses") {
          transmitted++;
          assert.equal(spend, 1);
          assert.equal(init.method, "POST");
          return Response.json({
            status: "completed",
            output: [
              {
                type: "web_search_call",
                status: "completed",
                action: {
                  type: "search",
                  sources: cited ? [{ url: source }] : [],
                },
              },
            ],
            output_text: JSON.stringify({
              claims: [{ genre: "house", url: source, quote: quoted }],
            }),
          });
        }
        assert.equal(value, source);
        return text(page);
      },
    });
    assert.equal(spend, Number(paid));
    assert.equal(transmitted, Number(paid));
    return facts;
  }
  const page = (account = ig, quote = evidence) =>
    `<title>Test Band | biography</title><a href="${account}">IG</a><p>${quote}</p>`;
  assert.deepEqual(keys(await find(page())), ["house"]);
  assert.deepEqual(keys(await find(page(ig + "o"))), []);
  assert.deepEqual(keys(await find(page(ig, "They perform live."))), []);
  assert.deepEqual(keys(await find(page(), directory, false)), []);
  assert.deepEqual(keys(await find(page(), "https://ra.co/events/12345")), []);
  assert.deepEqual(keys(await find(page(), directory, true, false)), []);
  const attributed =
    'Test Band, a house singer from London, with her band "Orion Band", explains her process.';
  const editorial = "<title>Interview</title><p>" + attributed + "</p>";
  const affiliation = await find(
    editorial,
    directory,
    true,
    true,
    "#singer #orionband",
    attributed,
  );
  assert.deepEqual(keys(affiliation), ["house"]);
  assert.deepEqual(affiliation.genres[0].binding, {
    url: ig,
    quote: "#singer #orionband",
  });
  assert.deepEqual(
    keys(
      await find(
        editorial,
        directory,
        true,
        true,
        "#singer #otherband",
        attributed,
      ),
    ),
    [],
  );
  assert.deepEqual(
    keys(
      instagramAccountFacts(
        handle,
        html("dnb / jungle").replace("Test Band (@", "(@"),
      ),
    ),
    ["drum-and-bass"],
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    researchPerformerAccount({
      handle,
      signal: controller.signal,
      fetch: async (_url, init) => {
        init.signal.throwIfAborted();
      },
    }),
  );
} finally {
  for (const [k, v] of [
    ["OPENAI_API_KEY", prevKey],
    ["OPENAI_REVIEW_MODEL", prevModel],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
console.log(
  "Artist account research passed provenance, identity, budget and cancellation checks.",
);
